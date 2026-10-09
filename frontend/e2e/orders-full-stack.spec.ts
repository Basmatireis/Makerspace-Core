import AxeBuilder from "@axe-core/playwright";
import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { operationKey } from "../src/features/orders/operations";
import type {
  Order,
  ExternalInvoiceRequest,
} from "../src/api/generated/models";

test.skip(
  process.env.PLAYWRIGHT_FULL_STACK !== "true",
  "Requires the isolated live Go/PostgreSQL stack.",
);
async function parse<T>(response: APIResponse): Promise<T> {
  const body = await response.text();
  expect(response.ok(), `${response.status()} ${body}`).toBeTruthy();
  return JSON.parse(body) as T;
}
async function accessibility(page: Page) {
  const result = await new AxeBuilder({ page })
    .include("#main-content")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations).toEqual([]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBeTruthy();
}

test("persists Orders, payment carry-forward, anonymous checkout and wiRef reconciliation in accessible UI", async ({
  page,
}, testInfo) => {
  test.setTimeout(180_000);
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
  const post = (path: string, data: unknown) =>
    page.request.post(`${origin}/api/v1${path}`, { headers, data });
  const put = (path: string, data: unknown) =>
    page.request.put(`${origin}/api/v1${path}`, { headers, data });
  const runTag = Date.now().toString();
  const organizationName = "Orders E2E institute " + runTag;
  const organization = await parse<{ id: string }>(
    await post("/organizations", { name: organizationName, kind: "institute" }),
  );
  await page.goto("/orders");
  await page.getByRole("button", { name: "New draft" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
  const orderId = page.url().split("/").at(-1)!;
  const payer = page.getByRole("combobox", {
    name: "Paying customer (optional for immediate fully paid sales)",
  });
  await payer.fill("Orders E2E");
  await page.getByRole("option", { name: organizationName }).click();
  await page.getByRole("button", { name: "Save draft details" }).click();
  await expect(
    page.getByRole("button", { name: "Finalize charges" }),
  ).toBeVisible();
  await page
    .getByLabel("Description", { exact: true })
    .fill("Special material service");
  await page.getByLabel("Unit price (€)", { exact: true }).fill("10");
  await page
    .getByRole("button", { name: "Add manual item", exact: true })
    .click();
  await expect(
    page.getByText("Special material service", { exact: true }),
  ).toBeVisible();
  await accessibility(page);
  await page.getByRole("button", { name: "Finalize charges" }).click();
  await expect(page.getByRole("heading", { name: "Settlement" })).toBeVisible();
  await page.getByLabel("Amount (€)", { exact: true }).fill("4");
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await expect(page.getByLabel("Amount (€)", { exact: true })).toHaveValue(
    "6.00",
  );
  await page.getByLabel("Payment method").selectOption("card");
  await page.getByLabel("Terminal/provider").fill("E2E terminal");
  await page
    .getByLabel("Confirmed terminal transaction reference")
    .fill("E2E-card-" + randomUUID());
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Record payment", exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (
          await parse<Order>(
            await page.request.get(`${origin}/api/v1/orders/${orderId}`),
          )
        ).settledAmount,
    )
    .toBe("10.00");
  const paid = await parse<Order>(
    await page.request.get(`${origin}/api/v1/orders/${orderId}`),
  );
  expect(paid.settledAmount).toBe("10.00");
  expect(paid.allocations).toHaveLength(2);
  await page.getByRole("button", { name: "Create replacement draft" }).click();
  await expect(page.getByText(/Replacement for/)).toBeVisible();
  const nextId = page.url().split("/").at(-1)!;
  await page.getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Unit price (€)", { exact: true }).fill("12");
  await page.getByRole("button", { name: "Save item changes" }).click();
  await expect(page.getByText(/1 piece ×/)).toContainText("12");
  await page.getByRole("link", { name: paid.reference, exact: true }).click();
  await page
    .getByLabel("Reason", { exact: true })
    .fill("Correct service charge");
  await page.getByLabel("Replacement draft").selectOption(nextId);
  await page
    .getByRole("button", { name: "Commit replacement and carry payments" })
    .click();
  await expect(page.getByText(/Replaced by/)).toBeVisible();
  const next = await parse<Order>(
    await page.request.get(`${origin}/api/v1/orders/${nextId}`),
  );
  expect(next.status).toBe("finalized");
  expect(next.settledAmount).toBe("10.00");
  expect(next.outstandingAmount).toBe("2.00");
  await page.getByRole("link", { name: next.reference, exact: true }).click();
  await accessibility(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("order-desktop.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await accessibility(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("order-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/payments");
  await expect(
    page.getByRole("heading", { name: "Payments", exact: true }),
  ).toBeVisible();
  await accessibility(page);
  await page
    .getByRole("link", {
      name: paid.allocations[0].paymentReference,
      exact: true,
    })
    .click();
  await expect(
    page.getByRole("heading", { name: "Allocation history" }),
  ).toBeVisible();
  await accessibility(page);
  // Price is reviewed before external terminal collection; completion is atomic.
  const type = await parse<{ id: string }>(
    await post("/machine-types", { name: "Orders E2E printer " + runTag }),
  );
  const machine = await parse<{ id: string }>(
    await post("/machines", {
      name: "Orders E2E counter printer " + runTag,
      machineTypeId: type.id,
      status: "active",
      automaticCollectionEnabled: false,
    }),
  );
  const group = await parse<{ id: string }>(
    await post("/pricing-groups", {
      name: "Orders E2E pricing " + runTag,
      isDefault: false,
    }),
  );
  await parse(
    await post(`/pricing-groups/${group.id}/rules`, {
      kind: "machine_runtime",
      machineTypeId: type.id,
      rate: "10",
    }),
  );
  await page.goto("/orders/counter-sale");
  await page.getByLabel("Machine", { exact: true }).selectOption(machine.id);
  await page
    .getByLabel("Pricing group", { exact: true })
    .selectOption(group.id);
  await page.getByRole("button", { name: "Review calculated charge" }).click();
  await expect(page.getByText(/Calculated total:.*10.00/)).toBeVisible();
  await page
    .getByLabel(
      "Service is fulfilled now; no later pickup or follow-up is required",
    )
    .press("Space");
  await accessibility(page);
  await page.getByRole("button", { name: "Complete counter sale" }).click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]+$/);
  const counter = await parse<Order>(
    await page.request.get(
      `${origin}/api/v1/orders/${page.url().split("/").at(-1)}`,
    ),
  );
  expect(counter.customerKind).toBe("anonymous");
  expect(counter.customer).toBeNull();
  expect(counter.settlementState).toBe("paid");
  // wiRef recipient fields are only required on its separate request.
  let externalOrder = await parse<Order>(
    await post("/orders", {
      customer: { kind: "organization", id: organization.id },
      fulfillmentMode: "deferred",
    }),
  );
  externalOrder = await parse<Order>(
    await post(`/orders/${externalOrder.id}/items`, {
      kind: "manual",
      description: "External billing service",
      quantity: "1",
      unit: "service",
      unitPrice: "20",
      expectedVersion: externalOrder.version,
    }),
  );
  externalOrder = await parse<Order>(
    await post(`/orders/${externalOrder.id}/finalize`, {
      expectedVersion: externalOrder.version,
      operationKey: operationKey(),
    }),
  );
  await parse(
    await put(`/organizations/${organization.id}/invoicing-requirements`, {
      expectedVersion: 0,
      requirePurchaseOrderReference: true,
    }),
  );
  await page.goto(`/orders/${externalOrder.id}`);
  await page.getByRole("button", { name: "Prepare wiRef request" }).click();
  await expect(page).toHaveURL(/\/external-invoicing\/[0-9a-f-]+$/);
  const requestId = page.url().split("/").at(-1)!;
  await page
    .getByLabel("Billing address", { exact: true })
    .fill("Workshop Street 1");
  await page.getByLabel("Postal code", { exact: true }).fill("8010");
  await page.getByLabel("Locality", { exact: true }).fill("Graz");
  await page.getByLabel("Country code", { exact: true }).fill("AT");
  await page
    .getByLabel("Organization contact person")
    .fill("Accounting contact");
  await page.getByLabel("Purchase order reference").fill("PO-E2E");
  await page.getByLabel("Service period from").fill("01.10.2026");
  await page.getByLabel("Service period through").fill("06.10.2026");
  await page
    .getByLabel("Type/description of service")
    .fill("External billing service");
  await page.getByRole("button", { name: "Save request details" }).click();
  // Wait for the new version before the next command.
  await expect
    .poll(
      async () =>
        (
          await parse<ExternalInvoiceRequest>(
            await page.request.get(
              `${origin}/api/v1/external-invoice-requests/${requestId}`,
            ),
          )
        ).version,
    )
    .toBe(2);
  await page.getByRole("button", { name: "Mark ready for invoicing" }).click();
  await expect(
    page.getByRole("button", { name: "Confirm submitted to wiRef" }),
  ).toBeVisible();
  await accessibility(page);
  await page
    .getByRole("button", { name: "Confirm submitted to wiRef" })
    .click();
  await page
    .getByLabel("External invoice/correction reference")
    .fill("wiRef-E2E-123");
  await page
    .getByRole("button", { name: "Record invoice issued externally" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Payment confirmed by wiRef" }),
  ).toBeVisible();
  await page
    .getByLabel("wiRef payment confirmation reference")
    .fill("wiRef-payment-E2E");
  await page
    .getByRole("button", { name: "Record payment", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Payment confirmed by wiRef" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Request external correction" })
    .click();
  await page
    .getByLabel("External accounting procedure")
    .selectOption("credit_note");
  await page
    .getByLabel("External invoice/correction reference")
    .fill("credit-note-E2E");
  await page
    .getByRole("button", { name: "Record external reconciliation evidence" })
    .click();
  await expect(
    page.getByText("Cancelled / externally reconciled", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await accessibility(page);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: testInfo.outputPath("wiref-narrow.png"),
    fullPage: true,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/orders/${externalOrder.id}`);
  const settled = await parse<Order>(
    await page.request.get(`${origin}/api/v1/orders/${externalOrder.id}`),
  );
  await page.getByLabel("Reason", { exact: true }).fill("External credit note");
  await page
    .getByLabel(
      `Reverse ${settled.allocations[0].paymentReference} in the same operation`,
    )
    .press("Space");
  await page
    .getByLabel("Payment correction", { exact: true })
    .selectOption("external_correction");
  await page
    .getByLabel("Card/external correction reference")
    .fill("credit-note-E2E");
  await page.getByRole("button", { name: "Reverse all charges" }).click();
  await expect(page.getByText(/full reversal/)).toBeVisible();
  const reversed = await parse<Order>(
    await page.request.get(`${origin}/api/v1/orders/${externalOrder.id}`),
  );
  expect(reversed.status).toBe("reversed");
  expect(reversed.netCharge).toBe("0.00");
  expect(browserErrors).toEqual([]);
});
