import {
  Button,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  TextInput,
  Tile,
  Pagination,
} from "@carbon/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  getOrderPayment,
  getPaymentReconciliation,
  reverseOrderPayment,
} from "../../api/generated/payments/payments";
import { getOrder } from "../../api/generated/orders/orders";
import type {
  PaymentInput,
  PaymentReversalInput,
} from "../../api/generated/models";
import { DateInput } from "../../app/DateInput";
import { PageShell } from "../../app/PageShell";
import { ErrorState, FullPageLoading } from "../../app/PageState";
import { useCurrentUser } from "../auth/auth";
import { hasPermission, PermissionId } from "../auth/permissions";
import { formatDateTime } from "../../app/dateTime";
import { formatMoney } from "./formatting";
import { FinancialError, PaymentForm } from "./shared";
import { financeKeys, useOperationKeys, cents } from "./operations";

export function PaymentsPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") || 1),
    pageSize = Number(params.get("pageSize") || 25);
  const filters = {
    page,
    pageSize,
    method: (params.get("method") || undefined) as
      | "cash"
      | "card"
      | "external"
      | undefined,
    from: params.get("from") ? `${params.get("from")}T00:00:00Z` : undefined,
    to: params.get("to") ? `${params.get("to")}T00:00:00Z` : undefined,
  };
  const query = useQuery({
    queryKey: [...financeKeys, "journal", filters],
    queryFn: () => getPaymentReconciliation(filters),
  });
  const update = (name: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(name, value);
    next.set("page", "1");
    setParams(next);
  };
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
        <div className="filter-bar">
          <Select
            id="journal-method"
            labelText="Method"
            value={filters.method || ""}
            onChange={(e) => update("method", e.target.value)}
          >
            <SelectItem value="" text="All methods" />
            <SelectItem value="cash" text="Cash" />
            <SelectItem value="card" text="Card" />
            <SelectItem value="external" text="Externally confirmed" />
          </Select>
          <DateInput
            id="journal-from"
            labelText="From (UTC date)"
            value={params.get("from") || ""}
            onChange={(v) => update("from", v)}
          />
          <DateInput
            id="journal-to"
            labelText="Before (UTC date)"
            value={params.get("to") || ""}
            onChange={(v) => update("to", v)}
          />
        </div>
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
        <StructuredListWrapper>
          <StructuredListBody>
            {query.data.entries.map((p) => (
              <StructuredListRow key={p.id}>
                <StructuredListCell>
                  <Link to={`/payments/${p.id}`}>{p.reference}</Link>
                </StructuredListCell>
                <StructuredListCell>
                  {p.method} ·{" "}
                  {p.entryKind === "reversal" ? p.reasonKind : p.entryKind}
                </StructuredListCell>
                <StructuredListCell>
                  {formatMoney(
                    p.entryKind === "reversal" ? `-${p.amount}` : p.amount,
                  )}
                </StructuredListCell>
                <StructuredListCell>
                  {formatDateTime(p.occurredAt)}
                </StructuredListCell>
              </StructuredListRow>
            ))}
          </StructuredListBody>
        </StructuredListWrapper>
        <Pagination
          page={page}
          pageSize={pageSize}
          pageSizes={[10, 25, 50, 100]}
          totalItems={query.data.total}
          onChange={({ page, pageSize }) => {
            const next = new URLSearchParams(params);
            next.set("page", String(page));
            next.set("pageSize", String(pageSize));
            setParams(next);
          }}
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
    onSuccess: () => client.invalidateQueries({ queryKey: financeKeys }),
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
              <Link to={`/payments/${p.reversesPaymentId}`}>
                {p.reversedPaymentReference}
              </Link>
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
              {a.orderId ? (
                <Link to={`/orders/${a.orderId}`}>{a.orderReference}</Link>
              ) : (
                a.orderReference
              )}
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
                  onClick={() => mutation.mutate()}
                >
                  Record full reversal
                </Button>
              </Stack>
            </Tile>
          )}
      </Stack>
    </PageShell>
  );
}
