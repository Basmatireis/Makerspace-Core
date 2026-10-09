import { http, HttpResponse } from "msw";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  PermissionId,
  type Order,
  type OrderCommand,
  type RecordOrderPayment,
  type CounterSaleCommand,
  type ExternalInvoiceRequest,
  type InvoiceRequestCommand,
} from "../../api/generated/models";
import { App } from "../../app/App";
import { currentUserFixture } from "../../test/fixtures";
import { renderRoute } from "../../test/render";
import { server } from "../../test/server";

const id = "01995ea6-6d00-7000-8000-000000000101";
const replacementId = "01995ea6-6d00-7000-8000-000000000102";
const itemId = "01995ea6-6d00-7000-8000-000000000103";
const requestId = "01995ea6-6d00-7000-8000-000000000104";
const machineId = "01995ea6-6d00-7000-8000-000000000105";
const at = "2026-10-06T10:00:00Z";
const all = [
  PermissionId.ordersread,
  PermissionId.orderswrite,
  PermissionId.ordersfinalize,
  PermissionId.ordersreverse,
  PermissionId.paymentsread,
  PermissionId.paymentsrecord,
  PermissionId.paymentsreverse,
  PermissionId.external_invoice_requestsread,
  PermissionId.external_invoice_requestsmanage,
];
function order(overrides: Partial<Order> = {}): Order {
  return {
    id,
    reference: "O-2026-000001",
    status: "draft",
    currency: "EUR",
    customerKind: "organization",
    customer: { kind: "organization", id: replacementId },
    customerName: "Example institute",
    fulfillmentMode: "immediate",
    totalAmount: "10.00",
    netCharge: "10.00",
    settledAmount: "0.00",
    outstandingAmount: "10.00",
    settlementState: "unpaid",
    replacesOrderId: null,
    replacesOrderReference: null,
    replacedByOrderId: null,
    replacedByOrderReference: null,
    activeExternalRequestId: null,
    activeExternalRequestReference: null,
    activeExternalRequestState: null,
    items: [
      {
        id: itemId,
        position: 1,
        kind: "manual",
        description: "Machine service",
        quantity: "1",
        unit: "service",
        unitPrice: "10",
        amount: "10.00",
        sourceChanged: false,
        createdAt: at,
      },
    ],
    allocations: [],
    adjustments: [],
    version: 2,
    createdAt: at,
    updatedAt: at,
    ...overrides,
  };
}
function me(perms: PermissionId[] = all) {
  server.use(
    http.get("*/api/v1/auth/me", () =>
      HttpResponse.json(currentUserFixture(perms)),
    ),
  );
}
function detail(o: Order) {
  server.use(
    http.get("*/api/v1/orders", () =>
      HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 }),
    ),
    http.get(`*/api/v1/orders/${o.id}`, () => HttpResponse.json(o)),
    http.get("*/api/v1/billing-parties", () =>
      HttpResponse.json({
        items: [
          {
            kind: "organization",
            id: replacementId,
            displayName: "Example institute",
            organizationKind: "institute",
            pricingGroup: null,
            pricingGroupAssignmentVersion: 0,
          },
        ],
      }),
    ),
  );
}

describe("Orders workflows", () => {
  it("keeps navigation and write actions permission-aware", async () => {
    me([PermissionId.ordersread]);
    server.use(
      http.get("*/api/v1/orders", () =>
        HttpResponse.json({
          items: [order()],
          page: 1,
          pageSize: 25,
          total: 1,
        }),
      ),
    );
    renderRoute(<App />, "/orders");
    await screen.findByRole("heading", { name: "Orders" });
    expect(screen.getByRole("link", { name: "Orders" })).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Payments" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "External invoicing" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "New draft" }),
    ).not.toBeInTheDocument();
  });
  it("retains the selected payer while asynchronous search results refresh", async () => {
    me();
    let current = order({
      customerKind: "anonymous",
      customer: null,
      customerName: null,
    });
    detail(current);
    server.use(
      http.get(`*/api/v1/orders/${id}`, () => HttpResponse.json(current)),
    );
    let submitted: Record<string, unknown> | undefined;
    server.use(
      http.patch(`*/api/v1/orders/${id}`, async ({ request }) => {
        submitted = (await request.json()) as Record<string, unknown>;
        current = order({ version: 3 });
        return HttpResponse.json(current);
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${id}`);
    const payer = await screen.findByRole("combobox", {
      name: "Paying customer (optional for immediate fully paid sales)",
    });
    await user.type(payer, "Example");
    await user.click(
      await screen.findByRole("option", { name: "Example institute" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save draft details" }),
    );
    await waitFor(() =>
      expect(submitted).toMatchObject({
        customer: { kind: "organization", id: replacementId },
        expectedVersion: 2,
      }),
    );
    expect(
      await screen.findByRole("button", { name: "Finalize charges" }),
    ).toBeInTheDocument();
  });
  it("edits draft items with current optimistic version and exact decimal strings", async () => {
    me();
    detail(order());
    let submitted: Record<string, unknown> | undefined;
    server.use(
      http.patch(
        `*/api/v1/orders/${id}/items/${itemId}`,
        async ({ request }) => {
          submitted = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json(order({ version: 3 }));
        },
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${id}`);
    await screen.findByRole("heading", { name: "O-2026-000001" });
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.clear(screen.getByLabelText("Unit price (€)"));
    await user.type(screen.getByLabelText("Unit price (€)"), "2.005");
    await user.click(screen.getByRole("button", { name: "Save item changes" }));
    await waitFor(() =>
      expect(submitted).toMatchObject({
        kind: "manual",
        unitPrice: "2.005",
        quantity: "1",
        expectedVersion: 2,
      }),
    );
  });
  it("finalizes identified charges without wiRef-specific information", async () => {
    me();
    detail(order());
    let submitted: OrderCommand | undefined;
    server.use(
      http.post(`*/api/v1/orders/${id}/finalize`, async ({ request }) => {
        submitted = (await request.json()) as OrderCommand;
        return HttpResponse.json(order({ status: "finalized", version: 3 }));
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${id}`);
    await screen.findByRole("heading", { name: "Finalize" });
    expect(screen.queryByLabelText("Billing address")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Finalize charges" }));
    await waitFor(() => expect(submitted?.expectedVersion).toBe(2));
    expect(submitted?.operationKey).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("requires anonymous checkout and validates card evidence accessibly", async () => {
    me();
    detail(
      order({ customerKind: "anonymous", customer: null, customerName: null }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${id}`);
    await screen.findByRole("heading", { name: "Finalize" });
    expect(
      screen.queryByRole("button", { name: "Finalize charges" }),
    ).not.toBeInTheDocument();
    await user.click(
      screen.getByLabelText("Finalize and record full payment now"),
    );
    await user.selectOptions(screen.getByLabelText("Payment method"), "card");
    await user.click(screen.getByRole("button", { name: "Record payment" }));
    expect(
      await screen.findByText("Terminal/provider is required"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Terminal/provider")).toHaveAttribute(
      "aria-invalid",
      "true",
    );
    expect(
      screen.getByText("Payment confirmation reference is required"),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Billing address")).not.toBeInTheDocument();
  });
  it("preserves the operation key when recording an externally confirmed card payment is retried", async () => {
    me();
    detail(order({ status: "finalized" }));
    const attempts: RecordOrderPayment[] = [];
    server.use(
      http.post(`*/api/v1/orders/${id}/payments`, async ({ request }) => {
        attempts.push((await request.json()) as RecordOrderPayment);
        return HttpResponse.json(
          { code: "internal_error", message: "Temporary database failure" },
          { status: 500 },
        );
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${id}`);
    await screen.findByRole("heading", { name: "Settlement" });
    await user.selectOptions(screen.getByLabelText("Payment method"), "card");
    await user.type(screen.getByLabelText("Terminal/provider"), "Terminal 1");
    await user.type(
      screen.getByLabelText("Confirmed terminal transaction reference"),
      "card-123",
    );
    await user.click(screen.getByRole("button", { name: "Record payment" }));
    await screen.findAllByText("Temporary database failure");
    await user.click(screen.getByRole("button", { name: "Record payment" }));
    await waitFor(() => expect(attempts).toHaveLength(2));
    expect(attempts[1]).toEqual(attempts[0]);
    expect(
      screen.getByText(/do not charge the card again/),
    ).toBeInTheDocument();
  });
  it("blocks cash/card UX while an active wiRef request controls settlement, without loading private recipient details", async () => {
    me([
      PermissionId.ordersread,
      PermissionId.paymentsread,
      PermissionId.paymentsrecord,
    ]);
    detail(
      order({
        status: "finalized",
        activeExternalRequestId: requestId,
        activeExternalRequestReference: "W-2026-000001",
        activeExternalRequestState: "submitted",
      }),
    );
    renderRoute(<App />, `/orders/${id}`);
    await screen.findByRole("heading", { name: "Settlement" });
    expect(screen.getByText(/W-2026-000001/)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Record payment" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "W-2026-000001" }),
    ).not.toBeInTheDocument();
  });
  it("commits a linked replacement explicitly without inventing a payment receipt", async () => {
    me();
    const original = order({
      status: "finalized",
      settledAmount: "10.00",
      outstandingAmount: "0.00",
      settlementState: "paid",
    });
    detail(original);
    const next = order({
      id: replacementId,
      reference: "O-2026-000002",
      replacesOrderId: id,
      replacesOrderReference: original.reference,
    });
    let submitted: OrderCommand | undefined;
    server.use(
      http.get("*/api/v1/orders", () =>
        HttpResponse.json({ items: [next], page: 1, pageSize: 100, total: 1 }),
      ),
      http.get(`*/api/v1/orders/${replacementId}`, () =>
        HttpResponse.json(next),
      ),
      http.post(`*/api/v1/orders/${id}/replace`, async ({ request }) => {
        submitted = (await request.json()) as OrderCommand;
        return HttpResponse.json(next);
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/orders/${id}`);
    await screen.findByRole("heading", {
      name: "Full reversal or replacement",
    });
    await user.type(screen.getByLabelText("Reason"), "Correct service");
    await screen.findByRole("option", { name: "O-2026-000002" });
    await user.selectOptions(
      screen.getByLabelText("Replacement draft"),
      replacementId,
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", {
          name: "Commit replacement and carry payments",
        }),
      ).toBeEnabled(),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Commit replacement and carry payments",
      }),
    );
    await waitFor(() =>
      expect(submitted).toMatchObject({
        replacementOrderId: replacementId,
        expectedReplacementVersion: 2,
        reason: "Correct service",
        payments: [],
      }),
    );
    expect(
      screen.getByText(/No customer credit is created/),
    ).toBeInTheDocument();
  });
  it("shows ready-request validation errors and keeps issuance separate from settlement", async () => {
    me();
    const r: ExternalInvoiceRequest = {
      id: requestId,
      reference: "W-2026-000001",
      orderId: id,
      orderReference: "O-2026-000001",
      provider: "wiref",
      state: "draft",
      currency: "EUR",
      requestedAmount: "10.00",
      details: { recipientName: "Example institute" },
      requirePurchaseOrderReference: true,
      requirementsVersion: 1,
      itemSummary: [],
      events: [],
      supersedesRequestId: null,
      version: 1,
      createdAt: at,
    };
    let submitted: InvoiceRequestCommand | undefined;
    detail(order({ status: "finalized" }));
    server.use(
      http.get(`*/api/v1/external-invoice-requests/${requestId}`, () =>
        HttpResponse.json(r),
      ),
      http.post(
        `*/api/v1/external-invoice-requests/${requestId}/ready`,
        async ({ request }) => {
          submitted = (await request.json()) as InvoiceRequestCommand;
          return HttpResponse.json(
            {
              code: "validation_failed",
              message: "Organizations require a contact person",
            },
            { status: 422 },
          );
        },
      ),
    );
    const user = userEvent.setup();
    renderRoute(<App />, `/external-invoicing/${requestId}`);
    await screen.findByRole("heading", {
      name: "Recipient and service snapshot",
    });
    await user.click(
      screen.getByRole("button", { name: "Mark ready for invoicing" }),
    );
    expect(
      await screen.findByText("Organizations require a contact person"),
    ).toBeInTheDocument();
    expect(submitted?.expectedVersion).toBe(1);
    expect(screen.getByText(/does not establish payment/)).toBeInTheDocument();
    expect(
      screen.getByLabelText("Organization contact person"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Purchase order reference"),
    ).toBeInTheDocument();
  });
  it("reviews the exact counter-sale charge before recording and creates no customer identity", async () => {
    me([
      ...all,
      PermissionId.machine_jobscreate,
      PermissionId.machinesread,
      PermissionId.pricingread,
    ]);
    let submitted: CounterSaleCommand | undefined;
    server.use(
      http.get("*/api/v1/machines", () =>
        HttpResponse.json({
          items: [{ id: machineId, name: "Printer" }],
          page: 1,
          pageSize: 100,
          total: 1,
        }),
      ),
      http.get("*/api/v1/pricing-groups", () =>
        HttpResponse.json({ items: [] }),
      ),
      http.get("*/api/v1/machine-job-operators", () =>
        HttpResponse.json({ items: [] }),
      ),
      http.post("*/api/v1/counter-sales/preview", () =>
        HttpResponse.json({ totalAmount: "10.00", currency: "EUR" }),
      ),
      http.post("*/api/v1/counter-sales", async ({ request }) => {
        submitted = (await request.json()) as CounterSaleCommand;
        return HttpResponse.json(
          order({
            customerKind: "anonymous",
            status: "finalized",
            customer: null,
            settlementState: "paid",
            outstandingAmount: "0.00",
          }),
        );
      }),
    );
    detail(order());
    const user = userEvent.setup();
    renderRoute(<App />, "/orders/counter-sale");
    await screen.findByRole("heading", { name: "Immediate counter sale" });
    expect(
      screen.getByRole("button", { name: "Complete counter sale" }),
    ).toBeDisabled();
    await screen.findByRole("option", { name: "Printer" });
    await user.selectOptions(screen.getByLabelText("Machine"), machineId);
    await user.click(
      screen.getByRole("button", { name: "Review calculated charge" }),
    );
    await screen.findByText("Calculated total: € 10.00");
    await user.click(
      screen.getByRole("button", { name: "Complete counter sale" }),
    );
    expect(
      await screen.findByText("Immediate fulfillment must be confirmed"),
    ).toBeInTheDocument();
    expect(submitted).toBeUndefined();
    await user.click(
      screen.getByLabelText(
        "Service is fulfilled now; no later pickup or follow-up is required",
      ),
    );
    await user.click(
      screen.getByRole("button", { name: "Complete counter sale" }),
    );
    await waitFor(() =>
      expect(submitted?.payments[0]).toMatchObject({
        amount: "10.00",
        method: "cash",
      }),
    );
    expect(submitted?.job.manualJob?.customer).toBeUndefined();
    expect(submitted?.job.manualJob?.operatorPersonId).toBe(
      currentUserFixture().person.id,
    );
  });
});
