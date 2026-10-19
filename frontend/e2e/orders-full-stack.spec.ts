import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { operationKey } from "../src/features/orders/operations";
import type { Order } from "../src/api/generated/models";

test.skip(
  process.env.PLAYWRIGHT_FULL_STACK !== "true",
  "Requires the isolated live Go/PostgreSQL stack.",
);

type Identified = { id: string; version: number };

async function parse<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.status()} ${body}`).toBeTruthy();
  return JSON.parse(body) as T;
}
/** Carbon modals are named by their label (the order reference); the heading is what identifies them. */
const dialogTitled = (page: Page, title: string) =>
  page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
/** Resizes and waits until the shell has switched between its wide and narrow layout. */
async function resize(page: Page, width: number, height: number) {
  await page.setViewportSize({ width, height });
  if (width < 672) {
    await expect(page.locator(".app-main")).toHaveCSS("margin-inline-start", "0px");
  }
}
async function accessibility(page: Page) {
  const result = await new AxeBuilder({ page })
    .include("#main-content")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    result.violations.map((violation) => ({
      rule: violation.id,
      targets: violation.nodes.map((node) => node.target.join(" ")),
    })),
  ).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
}

test("sells billable jobs and manual items, takes cash and card, runs the wiRef invoice approval and keeps the cashbook", async ({
  page,
}, testInfo) => {
  test.setTimeout(240_000);
  const browserErrors: string[] = [];
  page.on("pageerror", (e) => browserErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") browserErrors.push(m.text());
  });
  await page.goto("/login");
  await page.getByLabel("Email").fill("e2e-master@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("E2E master workshop passphrase 42");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/dashboard$/);
  browserErrors.length = 0;
  const origin = new URL(page.url()).origin;
  const csrf = (await page.context().cookies()).find((c) =>
    c.name.includes("csrf"),
  )!;
  const headers = { Origin: origin, "X-CSRF-Token": csrf.value };
  const get = (path: string) => page.request.get(`${origin}/api/v1${path}`);
  const post = (path: string, data: unknown) =>
    page.request.post(`${origin}/api/v1${path}`, { headers, data });
  const put = (path: string, data: unknown) =>
    page.request.put(`${origin}/api/v1${path}`, { headers, data });
  const orderOf = async (id: string) =>
    parse<Order>(await get(`/orders/${id}`));

  // Setup through the API: an organization with its own prices and one finished, priced job (two hours at 5.00).
  const runTag = Date.now().toString();
  const organizationName = "Orders E2E institute " + runTag;
  const me = await parse<{ person: { id: string } }>(await get("/auth/me"));
  const organization = await parse<
    Identified & { pricingGroupAssignmentVersion: number }
  >(await post("/organizations", { name: organizationName, kind: "institute" }));
  const machineType = await parse<Identified>(
    await post("/machine-types", {
      name: "Orders E2E workshop " + runTag,
      process: "other",
    }),
  );
  const machine = await parse<Identified>(
    await post("/machines", {
      name: "Orders E2E machine " + runTag,
      machineTypeId: machineType.id,
      status: "active",
      automaticCollectionEnabled: false,
    }),
  );
  const pricingGroup = await parse<Identified>(
    await post("/pricing-groups", {
      name: "Orders E2E pricing " + runTag,
      isDefault: false,
    }),
  );
  await parse<Identified>(
    await post(`/pricing-groups/${pricingGroup.id}/rules`, {
      kind: "machine_runtime",
      machineTypeId: machineType.id,
      rate: "5.00",
    }),
  );
  const assignment = await put("/billing-party-pricing-group", {
    party: { kind: "organization", id: organization.id },
    pricingGroupId: pricingGroup.id,
    expectedVersion: organization.pricingGroupAssignmentVersion,
  });
  expect(assignment.status(), await assignment.text()).toBe(204);
  const second = Math.floor(Date.now() / 1000) * 1000;
  const job = await parse<{ displayId: string; effectivePrice: string }>(
    await post("/machine-jobs", {
      machineId: machine.id,
      title: "Orders E2E bracket " + runTag,
      customer: { kind: "organization", id: organization.id },
      operatorPersonId: me.person.id,
      run: {
        startsAt: new Date(second - 121 * 60_000).toISOString(),
        endsAt: new Date(second - 60_000).toISOString(),
        outcome: "successful",
        usages: [],
      },
    }),
  );
  expect(Number(job.effectivePrice)).toBe(10);

  // 1. Review billable jobs: one draft order per customer, finalized and paid in cash in one step.
  await page.goto("/orders");
  await expect(
    page.getByRole("heading", { name: "Orders", level: 1 }),
  ).toBeVisible();
  await accessibility(page);
  await page.getByRole("button", { name: /^Review jobs \(\d+\)$/ }).click();
  const review = dialogTitled(page, "Jobs ready to bill");
  await expect(review).toBeVisible();
  await review
    .getByRole("checkbox", {
      name: `Select all ready jobs of ${organizationName}`,
    })
    .check({ force: true });
  await accessibility(page);
  await review.getByRole("button", { name: /^Create 1 order/ }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
  const cashOrderId = page.url().split("/").at(-1)!;
  const cashDraft = await orderOf(cashOrderId);
  expect(cashDraft.status).toBe("draft");
  expect(cashDraft.totalAmount).toBe("10.00");
  await expect(
    page.getByRole("heading", { name: cashDraft.reference, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(job.displayId).first()).toBeVisible();
  await accessibility(page);

  await page
    .getByRole("button", { name: "Finalize and take payment" })
    .click();
  let payment = dialogTitled(page, "Finalize and take payment");
  await expect(payment.getByLabel("Amount (€)")).toHaveValue("10,00");
  await accessibility(page);
  await payment
    .getByRole("button", { name: "Finalize and record payment" })
    .click();
  await expect(payment).toHaveCount(0);
  await expect
    .poll(async () => (await orderOf(cashOrderId)).settlementState)
    .toBe("paid");
  const cashPaid = await orderOf(cashOrderId);
  expect(cashPaid.settledAmount).toBe("10.00");
  expect(cashPaid.allocations).toHaveLength(1);
  await expect(
    page.getByRole("heading", { name: cashPaid.reference, level: 1 }),
  ).toBeVisible();

  // The receipt page.
  await page.getByRole("button", { name: "Print receipt" }).click();
  await expect(page).toHaveURL(new RegExp(`/orders/${cashOrderId}/receipt$`));
  await expect(
    page.getByRole("heading", { name: `Receipt for ${cashPaid.reference}` }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Payment receipt" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Print" })).toBeEnabled();
  await accessibility(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("receipt-desktop.png"),
    fullPage: true,
  });

  // 2. New order with a custom item, paid by card.
  await page.goto("/orders");
  await page.getByRole("button", { name: "New order" }).click();
  const createDialog = dialogTitled(page, "New order");
  await createDialog.getByRole("combobox", { name: "Customer" }).fill("Orders E2E");
  await page.getByRole("option", { name: organizationName }).click();
  await createDialog.getByRole("button", { name: "Create draft" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
  const cardOrderId = page.url().split("/").at(-1)!;
  await page.getByRole("button", { name: "Add items" }).click();
  await page.getByRole("menuitem", { name: "Custom item…" }).click();
  const item = dialogTitled(page, "Add custom item");
  await item.getByLabel("Description").fill("Special material service");
  await item.getByLabel("Unit price (€)").fill("12,50");
  await item.getByRole("button", { name: "Add item" }).click();
  await expect(
    page.getByText("Special material service", { exact: true }),
  ).toBeVisible();
  await accessibility(page);
  await page
    .getByRole("button", { name: "Finalize and take payment" })
    .click();
  payment = dialogTitled(page, "Finalize and take payment");
  await payment.getByRole("radio", { name: "Card" }).check({ force: true });
  await payment.getByLabel("Terminal or provider").fill("E2E terminal");
  await payment
    .getByLabel("Terminal transaction reference")
    .fill("E2E-card-" + randomUUID());
  await accessibility(page);
  await payment
    .getByRole("button", { name: "Finalize and record payment" })
    .click();
  await expect
    .poll(async () => (await orderOf(cardOrderId)).settlementState)
    .toBe("paid");
  const cardPaid = await orderOf(cardOrderId);
  expect(cardPaid.settledAmount).toBe("12.50");

  // The orders list keeps both under Paid.
  await page.goto("/orders");
  await page.getByRole("tab", { name: /^Paid \(\d+\)$/ }).click();
  await expect(
    page.getByRole("link", { name: cashPaid.reference, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: cardPaid.reference, exact: true }),
  ).toBeVisible();
  await accessibility(page);
  await resize(page, 390, 844);
  await accessibility(page);
  await resize(page, 1280, 900);

  // 3. wiRef invoice: request, submit, return with a comment, submit again, copy and mark forwarded.
  let invoiceOrder = await parse<Order>(
    await post("/orders", {
      customer: { kind: "organization", id: organization.id },
      fulfillmentMode: "deferred",
    }),
  );
  invoiceOrder = await parse<Order>(
    await post(`/orders/${invoiceOrder.id}/items`, {
      kind: "manual",
      description: "External billing service",
      quantity: "1",
      unit: "service",
      unitPrice: "20",
      expectedVersion: invoiceOrder.version,
    }),
  );
  invoiceOrder = await parse<Order>(
    await post(`/orders/${invoiceOrder.id}/finalize`, {
      expectedVersion: invoiceOrder.version,
      operationKey: operationKey(),
    }),
  );
  await page.goto(`/orders/${invoiceOrder.id}`);
  await page.getByRole("button", { name: "Record payment" }).click();
  payment = dialogTitled(page, "Record payment");
  await payment.getByRole("radio", { name: "Invoice" }).check({ force: true });
  await payment.getByRole("button", { name: "Request invoice" }).click();
  const request = dialogTitled(page, "Request invoice");
  await request.getByLabel("Street and number").fill("Workshop Street 1");
  await request.getByLabel("Postal code").fill("8010");
  await request.getByLabel("Town").fill("Graz");
  await request.getByLabel("Contact person").fill("Accounting contact");
  await accessibility(page);
  await request.getByRole("button", { name: "Request invoice" }).click();
  await expect(request).toHaveCount(0);

  const invoice = page.locator("#invoice");
  await expect(invoice.getByText("Next step", { exact: false })).toBeVisible();
  await accessibility(page);
  await invoice.getByRole("button", { name: "Submit for approval" }).click();
  await dialogTitled(page, "Submit for approval")
    .getByRole("button", { name: "Submit for approval" })
    .click();
  // The master account also approves: it returns the request with a comment.
  await expect(
    invoice.getByRole("button", { name: "Return for correction" }),
  ).toBeVisible();
  await expect(
    invoice.getByRole("button", { name: "Copy for wiRef" }),
  ).toBeVisible();
  await accessibility(page);
  await invoice.getByRole("button", { name: "Return for correction" }).click();
  const returning = dialogTitled(page, "Return for correction");
  await returning
    .getByLabel("What has to be corrected?")
    .fill("Please add the building to the address");
  await returning
    .getByRole("button", { name: "Return for correction" })
    .click();
  await expect(
    invoice.getByText("Returned for correction", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    invoice.getByText("Please add the building to the address").first(),
  ).toBeVisible();
  await accessibility(page);
  await invoice.getByRole("button", { name: "Submit for approval" }).click();
  await dialogTitled(page, "Submit for approval")
    .getByRole("button", { name: "Submit for approval" })
    .click();
  await invoice.getByRole("button", { name: "Copy for wiRef" }).click();
  const forward = dialogTitled(page, "Approve and forward to wiRef");
  await expect(forward.getByText("External billing service")).toBeVisible();
  await accessibility(page);
  await forward
    .getByRole("button", { name: "Mark as forwarded to wiRef" })
    .click();
  await expect(forward).toHaveCount(0);
  // Issued means paid: the invoice settled the order.
  await expect
    .poll(async () => (await orderOf(invoiceOrder.id)).settlementState)
    .toBe("paid");
  const settled = await orderOf(invoiceOrder.id);
  expect(settled.settledAmount).toBe("20.00");
  await expect(
    page.getByRole("table", { name: "Payments", exact: true }).getByText("Invoice (wiRef)"),
  ).toBeVisible();
  await expect(
    page.getByText("Issued, the order is paid", { exact: true }),
  ).toBeVisible();
  await accessibility(page);
  await resize(page, 390, 844);
  await accessibility(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("invoice-narrow.png"),
    fullPage: true,
  });
  await resize(page, 1280, 900);

  // 4. Cashbook: the invoice payment, a cash withdrawal and a cash deposit.
  await page.goto("/payments");
  await expect(
    page.getByRole("heading", { name: "Payments", level: 1 }),
  ).toBeVisible();
  const cashbook = page.getByRole("table", { name: "Payments" });
  await expect(cashbook.getByRole("cell", { name: "Invoice (wiRef)", exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Record cash withdrawal" }).click();
  let movement = dialogTitled(page, "Record cash withdrawal");
  await movement.getByLabel("Amount (€)").fill("5");
  await accessibility(page);
  await movement.getByRole("button", { name: "Record", exact: true }).click();
  await expect(movement).toHaveCount(0);
  await page.getByRole("button", { name: "Record cash deposit" }).click();
  movement = dialogTitled(page, "Record cash deposit");
  await movement.getByLabel("Amount (€)").fill("3");
  await movement.getByRole("button", { name: "Record", exact: true }).click();
  await expect(movement).toHaveCount(0);
  await expect(cashbook.getByText("Cash withdrawal")).toBeVisible();
  await expect(cashbook.getByText("Cash deposit")).toBeVisible();
  await accessibility(page);
  await resize(page, 390, 844);
  await accessibility(page);
  await resize(page, 1280, 900);
  const register = await parse<{ withdrawals: string; deposits: string }>(
    await get("/payments/cash-register"),
  );
  expect(Number(register.withdrawals)).toBeGreaterThanOrEqual(5);
  expect(Number(register.deposits)).toBeGreaterThanOrEqual(3);

  expect(browserErrors).toEqual([]);
});
