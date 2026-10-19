import {
  Button,
  Select,
  SelectItem,
  Stack,
  TextInput,
  Tile,
} from "@carbon/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useParams } from "react-router-dom";
import {
  getOrderPayment,
  getPaymentReconciliation,
  reverseOrderPayment,
} from "../../api/generated/payments/payments";
import { getOrder } from "../../api/generated/orders/orders";
import type {
  OrderPayment,
  PaymentInput,
  PaymentReversalInput,
} from "../../api/generated/models";
import { DateInput } from "../../app/DateInput";
import { RefLink } from "../../app/RefLink";
import { PageShell } from "../../app/PageShell";
import { DestructiveActionDialog } from "../../app/DestructiveActionDialog";
import { ErrorState, FullPageLoading } from "../../app/PageState";
import { useCurrentUser } from "../auth/auth";
import { hasPermission, PermissionId } from "../auth/permissions";
import { formatDateTime } from "../../app/dateTime";
import { formatMoney } from "./formatting";
import { FinancialError, PaymentForm } from "./shared";
import { financeKeys, useOperationKeys, cents } from "./operations";
import { DirectoryTable, useServerTableState, type Column, type Option } from "../machinelogbook/shared/DirectoryTable";

const PAGE_SIZES = [10, 25, 50, 100];
const METHOD_OPTIONS: Option[] = [
  { id: "cash", label: "Cash" },
  { id: "card", label: "Card" },
  { id: "external", label: "Externally confirmed" },
];

const columns: Column<OrderPayment>[] = [
  {
    key: "reference", header: "Payment",
    render: (p) => (
      <div className="mj-cell-stack">
        <RefLink reference={p.reference} id={p.id} />
        {p.reversedPaymentReference && <span className="mj-secondary">Reverses <RefLink reference={p.reversedPaymentReference} id={p.reversesPaymentId} /></span>}
      </div>
    ),
  },
  { key: "kind", header: "Method", render: (p) => `${p.method} · ${p.entryKind === "reversal" ? p.reasonKind : p.entryKind}` },
  { key: "amount", header: "Amount", render: (p) => formatMoney(p.entryKind === "reversal" ? `-${p.amount}` : p.amount) },
  { key: "occurredAt", header: "Date", narrow: true, render: (p) => formatDateTime(p.occurredAt) },
];

export function PaymentsPage() {
  const table = useServerTableState("", { key: "", direction: "ASC" }, PAGE_SIZES, 25);
  const { url } = table;
  const from = url.get("from");
  const to = url.get("to");
  const filters = {
    page: table.page,
    pageSize: table.pageSize,
    method: (url.get("method") || undefined) as
      | "cash"
      | "card"
      | "external"
      | undefined,
    from: from ? `${from}T00:00:00Z` : undefined,
    to: to ? `${to}T00:00:00Z` : undefined,
  };
  const query = useQuery({
    placeholderData: keepPreviousData,
    queryKey: [...financeKeys, "journal", filters],
    queryFn: () => getPaymentReconciliation(filters),
  });
  if (query.isPending) return <FullPageLoading label="Loading payments" />;
  if (query.isError)
    return (
      <ErrorState
        message="Payments could not be loaded."
        onRetry={() => query.refetch()}
      />
    );
  return (
    <PageShell
      title="Payments"
      description="Cashbook references and recorded cash/card activity. Allocation transfers do not move money."
      width="wide"
    >
      <Stack gap={6}>
        <Tile>
          <p>
            Period totals across methods: cash {formatMoney(query.data.cash)} ·
            card {formatMoney(query.data.card)} · externally confirmed{" "}
            {formatMoney(query.data.external)}
          </p>
          <p>
            These are recorded activities, not a complete physical cash balance.
            Recording-error corrections are distinguished from actual refunds.
          </p>
        </Tile>
        <DirectoryTable<OrderPayment>
          mode="server" id="payments" urlPrefix="" label="Payments" columns={columns} searchable={false}
          rows={query.data.entries} total={query.data.total} pageSizes={PAGE_SIZES} defaultPageSize={25}
          filterCategories={[
            { key: "method", label: "Method", options: METHOD_OPTIONS, single: true },
            {
              key: "period", label: "Period", keys: ["from", "to"],
              render: ({ idPrefix, staged, set }) => (
                <>
                  <DateInput id={`${idPrefix}-from`} labelText="From (UTC date)" value={staged.from?.[0] ?? ""} onChange={(value) => set("from", value ? [value] : [])} />
                  <DateInput id={`${idPrefix}-to`} labelText="Before (UTC date)" value={staged.to?.[0] ?? ""} onChange={(value) => set("to", value ? [value] : [])} />
                </>
              ),
            },
          ]}
          empty={{ title: "No payments yet", description: "Recorded cash, card and externally confirmed payments appear here." }}
        />
      </Stack>
    </PageShell>
  );
}
export function PaymentDetailPage() {
  const { paymentId = "" } = useParams();
  return <PaymentDetailPageContent key={paymentId} paymentId={paymentId} />;
}

function PaymentDetailPageContent({ paymentId }: { paymentId: string }) {
  const user = useCurrentUser();
  const client = useQueryClient();
  const key = useOperationKeys();
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [kind, setKind] =
    useState<PaymentReversalInput["reasonKind"]>("refund");
  const [occurredAt] = useState(() => new Date().toISOString());
  const [replacement, setReplacement] = useState<PaymentInput>();
  const [confirmReversal, setConfirmReversal] = useState(false);
  const query = useQuery({
    queryKey: [...financeKeys, "payment", paymentId],
    queryFn: () => getOrderPayment(paymentId),
  });
  const allocated = query.data?.allocations;
  const activeOrderId = allocated?.find(
    (a) =>
      a.orderId &&
      allocated
        .filter((v) => v.orderId === a.orderId)
        .reduce((n, v) => n + cents(v.amount), 0n) > 0n,
  )?.orderId;
  const order = useQuery({
    queryKey: [...financeKeys, "detail", activeOrderId],
    queryFn: () => getOrder(activeOrderId!),
    enabled: !!activeOrderId && hasPermission(user, PermissionId.ordersread),
  });
  const mutation = useMutation({
    mutationFn: () => {
      const input = {
        expectedVersion: order.data!.version,
        reversal: {
          paymentId,
          reasonKind: kind,
          reason,
          occurredAt,
          externalReference: reference,
        },
        replacementPayment: replacement,
      };
      return reverseOrderPayment(paymentId, {
        ...input,
        operationKey: key("reverse", input),
      });
    },
    onSuccess: async () => {
      setConfirmReversal(false);
      await client.invalidateQueries({ queryKey: financeKeys });
    },
  });
  if (query.isPending) return <FullPageLoading label="Loading payment" />;
  if (query.isError)
    return (
      <ErrorState
        message="Payment could not be loaded."
        onRetry={() => query.refetch()}
      />
    );
  const p = query.data;
  return (
    <PageShell
      title={p.reference}
      description="Immutable payment evidence"
      breadcrumbs={[
        { label: "Payments", to: "/payments" },
        { label: p.reference },
      ]}
    >
      <Stack gap={6}>
        <Tile>
          <p>
            {p.method} · {p.entryKind} · {formatMoney(p.amount)}
          </p>
          <p>
            Occurred {formatDateTime(p.occurredAt)} · recorded{" "}
            {formatDateTime(p.recordedAt)}
          </p>
          {p.reversesPaymentId && (
            <p>
              Reversal of{" "}
              <RefLink reference={p.reversedPaymentReference ?? ""} id={p.reversesPaymentId} />
            </p>
          )}
          <p>{p.reason}</p>
          <p>
            {p.externalSource} {p.externalReference}
          </p>
        </Tile>
        <Tile>
          <h2>Allocation history</h2>
          {p.allocations.map((a) => (
            <p key={a.id}>
              <RefLink reference={a.orderReference ?? ""} id={a.orderId} />
              : € {a.amount}
            </p>
          ))}
        </Tile>
        {p.entryKind === "receipt" &&
          order.data &&
          hasPermission(user, PermissionId.paymentsreverse) && (
            <Tile>
              <h2>Reverse the full payment</h2>
              <Stack gap={5}>
                <Select
                  id="reverse-kind"
                  labelText="Correction kind"
                  value={kind}
                  onChange={(e) =>
                    setKind(
                      e.target.value as PaymentReversalInput["reasonKind"],
                    )
                  }
                >
                  <SelectItem value="refund" text="Actual refund" />
                  <SelectItem value="recording_error" text="Recording error" />
                  {p.method === "external" && (
                    <SelectItem
                      value="external_correction"
                      text="External accounting correction"
                    />
                  )}
                </Select>
                <TextInput
                  id="reverse-reason"
                  labelText="Reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
                {p.method !== "cash" && (
                  <TextInput
                    id="reverse-reference"
                    labelText="Correction evidence/reference"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                  />
                )}{" "}
                {order.data.customerKind === "anonymous" &&
                  hasPermission(user, PermissionId.paymentsrecord) && (
                    <>
                      <p>
                        An anonymous Order must remain fully paid. Confirm a
                        replacement receipt in this same correction, or reverse
                        the whole Order from its detail page.
                      </p>
                      <PaymentForm
                        defaultAmount={p.amount}
                        pending={false}
                        error={null}
                        onSubmit={setReplacement}
                      />
                      {replacement && (
                        <p>
                          Replacement receipt staged: {replacement.method}{" "}
                          {formatMoney(replacement.amount)}
                        </p>
                      )}
                    </>
                  )}
                <FinancialError error={mutation.error} />
                <Button
                  kind="danger"
                  disabled={!reason || mutation.isPending}
                  onClick={() => { mutation.reset(); setConfirmReversal(true); }}
                >
                  Record full reversal
                </Button>
                <DestructiveActionDialog
                  open={confirmReversal}
                  title={`Reverse payment ${p.reference}?`}
                  confirmLabel="Record full reversal"
                  pending={mutation.isPending}
                  error={mutation.error?.message}
                  onClose={() => { setConfirmReversal(false); mutation.reset(); }}
                  onConfirm={() => mutation.mutate()}
                >
                  <p>The full {formatMoney(p.amount)} receipt will be reversed. The original payment, its allocations, and this correction remain as immutable financial evidence.</p>
                  <p>Correction: {kind.replaceAll("_", " ")} · Reason: {reason}{reference ? ` · Evidence: ${reference}` : ""}</p>
                  {replacement && <p>A replacement {replacement.method} receipt for {formatMoney(replacement.amount)} will be recorded in the same operation.</p>}
                </DestructiveActionDialog>
              </Stack>
            </Tile>
          )}
      </Stack>
    </PageShell>
  );
}
