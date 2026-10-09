import {
  Button,
  Checkbox,
  ComboBox,
  InlineNotification,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Tag,
  TextInput,
  Tile,
} from "@carbon/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import {
  addOrderItem,
  cancelOrder,
  checkoutOrder,
  createReplacementOrder,
  finalizeOrder,
  getOrder,
  listOrders,
  refreshOrderItem,
  removeOrderItem,
  updateOrderItem,
  replaceOrder,
  reverseOrder,
  updateOrder,
} from "../../api/generated/orders/orders";
import { recordOrderPayment } from "../../api/generated/payments/payments";
import { createExternalInvoiceRequest } from "../../api/generated/external-invoicing/external-invoicing";
import { listMachineJobs } from "../../api/generated/machine-jobs/machine-jobs";
import type {
  OrderCommand,
  OrderCustomer,
  PaymentInput,
  PaymentReversalInput,
} from "../../api/generated/models";
import { useCurrentUser } from "../auth/auth";
import { hasPermission, PermissionId } from "../auth/permissions";
import { PageShell } from "../../app/PageShell";
import { ErrorState, FullPageLoading } from "../../app/PageState";
import { CustomerPicker, FinancialError, PaymentForm } from "./shared";
import { financeKeys, useOperationKeys, cents } from "./operations";
import { formatMoney } from "./formatting";

export function OrderDetailPage() {
  const { orderId = "" } = useParams();
  return <OrderDetailContent key={orderId} orderId={orderId} />;
}

function OrderDetailContent({ orderId }: { orderId: string }) {
  const user = useCurrentUser();
  const client = useQueryClient();
  const navigate = useNavigate();
  const key = useOperationKeys();
  const query = useQuery({
    queryKey: [...financeKeys, "detail", orderId],
    queryFn: () => getOrder(orderId),
  });
  const [customer, setCustomer] = useState<OrderCustomer | null | undefined>();
  const [mode, setMode] = useState<"immediate" | "deferred" | undefined>();
  const [reason, setReason] = useState("");
  const [payCheckout, setPayCheckout] = useState(false);
  const [jobSearch, setJobSearch] = useState("");
  const [selectedJob, setSelectedJob] = useState<string>("");
  const jobs = useQuery({
    queryKey: [...financeKeys, "eligible-jobs", jobSearch],
    queryFn: () =>
      listMachineJobs({
        search: jobSearch,
        reviewState: "confirmed",
        page: 1,
        pageSize: 25,
      }),
    enabled:
      query.data?.status === "draft" &&
      hasPermission(user, PermissionId.machine_jobsread),
  });
  const [editingItem, setEditingItem] = useState<string>();
  const form = useForm<{
    description: string;
    quantity: string;
    unit: string;
    unitPrice: string;
  }>({
    defaultValues: {
      description: "",
      quantity: "1",
      unit: "piece",
      unitPrice: "",
    },
  });
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: financeKeys });
    await client.invalidateQueries({ queryKey: ["machine-logbook"] });
  };
  const mutation = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: refresh,
  });
  if (query.isPending) return <FullPageLoading label="Loading order" />;
  if (query.isError)
    return (
      <ErrorState
        message="Order could not be loaded."
        onRetry={() => query.refetch()}
      />
    );
  const o = query.data;
  const can = (p: PermissionId) => hasPermission(user, p);
  const command = (
    action: string,
    extra: Partial<OrderCommand> = {},
  ): OrderCommand => {
    const input = { expectedVersion: o.version, ...extra };
    return { ...input, operationKey: key(action, input) };
  };
  const run = (fn: () => Promise<unknown>) => mutation.mutate(fn);
  const activeRequest = o.activeExternalRequestId;
  const currentCustomer = customer === undefined ? o.customer : customer;
  const payment = (p: PaymentInput) =>
    run(() => {
      const input = { expectedVersion: o.version, payment: p };
      return recordOrderPayment(o.id, {
        ...input,
        operationKey: key("payment", input),
      });
    });
  return (
    <PageShell
      title={o.reference}
      description="Internal charge record"
      breadcrumbs={[{ label: "Orders", to: "/orders" }, { label: o.reference }]}
      width="wide"
      actions={
        <>
          <Tag>{o.status}</Tag>
          <Tag>{o.settlementState.replaceAll("_", " ")}</Tag>
        </>
      }
    >
      <Stack gap={6}>
        {o.replacedByOrderId && (
          <p>
            Replaced by{" "}
            <Link to={`/orders/${o.replacedByOrderId}`}>
              {o.replacedByOrderReference}
            </Link>
            .
          </p>
        )}
        <FinancialError error={mutation.error} />
        {o.replacesOrderId && (
          <p>
            Replacement for{" "}
            <Link to={`/orders/${o.replacesOrderId}`}>
              {o.replacesOrderReference}
            </Link>
            .{o.status === "draft" && " Commit from the original Order."}
          </p>
        )}
        <Tile>
          <h2>Customer and charge</h2>
          {o.status === "draft" && can(PermissionId.orderswrite) ? (
            <Stack gap={5}>
              <CustomerPicker
                value={currentCustomer}
                customerName={o.customerName}
                onChange={setCustomer}
              />
              <Select
                id="fulfillment"
                labelText="Fulfillment"
                value={mode || o.fulfillmentMode}
                onChange={(e) =>
                  setMode(e.target.value as "immediate" | "deferred")
                }
              >
                <SelectItem
                  value="immediate"
                  text="Immediate — no later pickup/follow-up"
                />
                <SelectItem
                  value="deferred"
                  text="Deferred — named customer required"
                />
              </Select>
              <Button
                disabled={mutation.isPending}
                onClick={() =>
                  run(() =>
                    updateOrder(o.id, {
                      customer: currentCustomer,
                      fulfillmentMode: mode || o.fulfillmentMode,
                      expectedVersion: o.version,
                    }),
                  )
                }
              >
                Save draft details
              </Button>
            </Stack>
          ) : (
            <p>
              {o.customerName || o.customerKind} · {o.fulfillmentMode}
            </p>
          )}
          <dl className="amount-list">
            <div>
              <dt>Original charge</dt>
              <dd>{formatMoney(o.totalAmount)}</dd>
            </div>
            <div>
              <dt>Net charge</dt>
              <dd>{formatMoney(o.netCharge)}</dd>
            </div>
            <div>
              <dt>Allocated payments</dt>
              <dd>{formatMoney(o.settledAmount)}</dd>
            </div>
            <div>
              <dt>Outstanding</dt>
              <dd>{formatMoney(o.outstandingAmount)}</dd>
            </div>
          </dl>
        </Tile>
        <Tile>
          <h2>Items</h2>
          <StructuredListWrapper>
            <StructuredListBody>
              {o.items
                .filter((i) => !i.removedAt)
                .map((i) => (
                  <StructuredListRow key={i.id}>
                    <StructuredListCell>
                      {i.description}
                      {i.sourceMachineJobId && (
                        <p>
                          <Link
                            to={`/machine-logbook/jobs/${i.sourceMachineJobId}`}
                          >
                            Source job
                          </Link>
                        </p>
                      )}
                      {i.sourceChanged && (
                        <InlineNotification
                          kind="warning"
                          title="Source job changed"
                          subtitle="This charge snapshot is unchanged. Refresh while draft, or reverse/replace a finalized charge."
                          hideCloseButton
                        />
                      )}
                      {i.snapshot && (
                        <p>
                          {i.snapshot.pricing?.pricingGroupName} ·{" "}
                          {i.snapshot.startsAt} – {i.snapshot.endsAt}
                        </p>
                      )}
                    </StructuredListCell>
                    <StructuredListCell>
                      {i.quantity} {i.unit} × € {i.unitPrice}
                    </StructuredListCell>
                    <StructuredListCell>
                      {formatMoney(i.amount)}
                    </StructuredListCell>
                    {o.status === "draft" && can(PermissionId.orderswrite) && (
                      <StructuredListCell>
                        {i.kind === "manual" && (
                          <Button
                            size="sm"
                            kind="ghost"
                            onClick={() => {
                              setEditingItem(i.id);
                              form.reset({
                                description: i.description,
                                quantity: i.quantity,
                                unit: i.unit,
                                unitPrice: i.unitPrice,
                              });
                            }}
                          >
                            Edit
                          </Button>
                        )}
                        <Button
                          size="sm"
                          kind="danger--tertiary"
                          onClick={() =>
                            run(() =>
                              removeOrderItem(
                                o.id,
                                i.id,
                                command("remove-" + i.id),
                              ),
                            )
                          }
                        >
                          Remove
                        </Button>
                        {i.sourceChanged && (
                          <Button
                            size="sm"
                            kind="ghost"
                            onClick={() =>
                              run(() =>
                                refreshOrderItem(
                                  o.id,
                                  i.id,
                                  command("refresh-" + i.id),
                                ),
                              )
                            }
                          >
                            Refresh snapshot
                          </Button>
                        )}
                      </StructuredListCell>
                    )}
                  </StructuredListRow>
                ))}
            </StructuredListBody>
          </StructuredListWrapper>
          {o.status === "draft" && can(PermissionId.orderswrite) && (
            <Stack gap={5}>
              <h3>{editingItem ? "Edit manual item" : "Add manual item"}</h3>
              <form
                onSubmit={form.handleSubmit((v) =>
                  run(async () => {
                    const input = {
                      ...v,
                      kind: "manual" as const,
                      expectedVersion: o.version,
                    };
                    if (editingItem)
                      await updateOrderItem(o.id, editingItem, input);
                    else await addOrderItem(o.id, input);
                    setEditingItem(undefined);
                    form.reset({
                      description: "",
                      quantity: "1",
                      unit: "piece",
                      unitPrice: "",
                    });
                  }),
                )}
              >
                <Stack gap={4}>
                  {(
                    ["description", "quantity", "unit", "unitPrice"] as const
                  ).map((n) => (
                    <TextInput
                      key={n}
                      id={"item-" + n}
                      labelText={
                        {
                          description: "Description",
                          quantity: "Quantity",
                          unit: "Unit",
                          unitPrice: "Unit price (€)",
                        }[n]
                      }
                      {...form.register(n, { required: "Required" })}
                      invalid={!!form.formState.errors[n]}
                      invalidText={form.formState.errors[n]?.message}
                    />
                  ))}
                  <Button type="submit" disabled={mutation.isPending}>
                    {editingItem ? "Save item changes" : "Add manual item"}
                  </Button>
                  {editingItem && (
                    <Button
                      kind="ghost"
                      onClick={() => {
                        setEditingItem(undefined);
                        form.reset({
                          description: "",
                          quantity: "1",
                          unit: "piece",
                          unitPrice: "",
                        });
                      }}
                    >
                      Cancel item edit
                    </Button>
                  )}
                </Stack>
              </form>
              {can(PermissionId.machine_jobsread) && (
                <>
                  <h3>Add Machine Job</h3>
                  <ComboBox
                    id="order-job"
                    titleText="Confirmed job"
                    items={jobs.data?.items ?? []}
                    itemToString={(j) =>
                      j
                        ? `${j.displayId} · ${j.machine.name} · ${formatMoney(j.effectivePrice)}`
                        : ""
                    }
                    onInputChange={setJobSearch}
                    onChange={({ selectedItem }) =>
                      setSelectedJob(selectedItem?.id || "")
                    }
                  />
                  <Button
                    disabled={!selectedJob || mutation.isPending}
                    onClick={() => {
                      const job = jobs.data?.items.find(
                        (j) => j.id === selectedJob,
                      );
                      if (job)
                        run(() =>
                          addOrderItem(o.id, {
                            kind: "machine_job",
                            machineJobId: job.id,
                            expectedJobVersion: job.version,
                            expectedVersion: o.version,
                          }),
                        );
                    }}
                  >
                    Add job snapshot
                  </Button>
                </>
              )}
            </Stack>
          )}
        </Tile>
        {o.status === "draft" &&
          can(PermissionId.ordersfinalize) &&
          !o.replacesOrderId && (
            <Tile>
              <h2>Finalize</h2>
              <Stack gap={5}>
                <p>
                  Finalizing freezes these charges. Anonymous sales require full
                  immediate cash/card settlement.
                </p>
                {o.customerKind !== "anonymous" && (
                  <Button
                    disabled={mutation.isPending}
                    onClick={() =>
                      run(() => finalizeOrder(o.id, command("finalize")))
                    }
                  >
                    Finalize charges
                  </Button>
                )}
                {can(PermissionId.paymentsrecord) &&
                  can(PermissionId.paymentsread) && (
                    <>
                      <Checkbox
                        id="checkout-now"
                        labelText="Finalize and record full payment now"
                        checked={payCheckout}
                        onChange={(_, v) => setPayCheckout(v.checked)}
                      />
                      {payCheckout && (
                        <PaymentForm
                          key={o.version}
                          defaultAmount={o.totalAmount}
                          pending={mutation.isPending}
                          error={mutation.error}
                          onSubmit={(p) =>
                            run(() =>
                              checkoutOrder(
                                o.id,
                                command("checkout", {
                                  payments: cents(p.amount) === 0n ? [] : [p],
                                }),
                              ),
                            )
                          }
                        />
                      )}
                    </>
                  )}
                {can(PermissionId.orderswrite) && (
                  <Button
                    kind="danger--tertiary"
                    onClick={() =>
                      run(() => cancelOrder(o.id, command("cancel")))
                    }
                  >
                    Cancel draft
                  </Button>
                )}
              </Stack>
            </Tile>
          )}
        {o.status === "finalized" && (
          <Tile>
            <h2>Settlement</h2>
            <Stack gap={5}>
              {activeRequest ? (
                <p>
                  {can(PermissionId.external_invoice_requestsread) ? (
                    <Link to={`/external-invoicing/${activeRequest}`}>
                      {o.activeExternalRequestReference}
                    </Link>
                  ) : (
                    o.activeExternalRequestReference
                  )}{" "}
                  · {o.activeExternalRequestState} · external invoicing through
                  wiRef
                </p>
              ) : (
                <>
                  {can(PermissionId.paymentsrecord) &&
                    can(PermissionId.paymentsread) &&
                    o.outstandingAmount !== "0.00" && (
                      <PaymentForm
                        key={o.version}
                        defaultAmount={o.outstandingAmount}
                        pending={mutation.isPending}
                        error={mutation.error}
                        onSubmit={payment}
                      />
                    )}{" "}
                  {can(PermissionId.external_invoice_requestsmanage) &&
                    can(PermissionId.external_invoice_requestsread) &&
                    o.customerKind !== "anonymous" &&
                    o.settledAmount === "0.00" && (
                      <Button
                        kind="secondary"
                        onClick={() =>
                          run(async () => {
                            const input = {
                              expectedVersion: o.version,
                              details: { recipientName: o.customerName || "" },
                            };
                            const r = await createExternalInvoiceRequest(o.id, {
                              ...input,
                              operationKey: key("request", input),
                            });
                            navigate(`/external-invoicing/${r.id}`);
                          })
                        }
                      >
                        Prepare wiRef request
                      </Button>
                    )}
                </>
              )}
              <h3>Payment allocation history</h3>
              {o.allocations.map((a) => (
                <p key={a.id}>
                  {can(PermissionId.paymentsread) && a.paymentId ? (
                    <Link to={`/payments/${a.paymentId}`}>
                      {a.paymentReference}
                    </Link>
                  ) : (
                    a.paymentReference
                  )}
                  : € {a.amount}
                </p>
              ))}
              <p>
                Allocation transfers move settlement between Orders and do not
                move cash/card money.
              </p>
            </Stack>
          </Tile>
        )}
        {(o.status === "finalized" || o.status === "reversed") &&
          !o.replacedByOrderId &&
          can(PermissionId.orderswrite) && (
            <Button
              kind="secondary"
              onClick={() =>
                run(async () => {
                  const next = await createReplacementOrder(
                    o.id,
                    command("replacements"),
                  );
                  navigate(`/orders/${next.id}`);
                })
              }
            >
              Create replacement draft
            </Button>
          )}
        {(o.status === "finalized" || o.status === "reversed") &&
          !o.replacedByOrderId &&
          can(PermissionId.ordersreverse) && (
            <CorrectionPanel
              status={o.status}
              orderId={o.id}
              version={o.version}
              reason={reason}
              setReason={setReason}
              run={run}
              command={command}
              canCarry={
                can(PermissionId.ordersfinalize) &&
                can(PermissionId.paymentsrecord) &&
                can(PermissionId.paymentsread)
              }
              canReversePayments={
                can(PermissionId.paymentsreverse) &&
                can(PermissionId.paymentsread)
              }
              allocations={o.allocations}
              pending={mutation.isPending}
            />
          )}
        {o.adjustments.map((a) => (
          <Tile key={a.id}>
            <h2>{a.reference} — full reversal</h2>
            <p>
              {formatMoney(a.amount)} · {a.reason}
            </p>
          </Tile>
        ))}
      </Stack>
    </PageShell>
  );
}
function CorrectionPanel({
  orderId,
  status,
  version,
  reason,
  setReason,
  run,
  command,
  canCarry,
  canReversePayments,
  allocations,
  pending,
}: {
  orderId: string;
  status: string;
  version: number;
  reason: string;
  setReason: (v: string) => void;
  run: (fn: () => Promise<unknown>) => void;
  command: (a: string, e?: Partial<OrderCommand>) => OrderCommand;
  canCarry: boolean;
  canReversePayments: boolean;
  allocations: import("../../api/generated/models").OrderAllocation[];
  pending: boolean;
}) {
  const [newPayment, setNewPayment] = useState<PaymentInput>();
  const [addPayment, setAddPayment] = useState(false);
  const [replacementId, setReplacementId] = useState("");
  const [reverseIds, setReverseIds] = useState<string[]>([]);
  const [correctionReference, setCorrectionReference] = useState("");
  const [kind, setKind] =
    useState<PaymentReversalInput["reasonKind"]>("refund");
  const [occurredAt] = useState(() => new Date().toISOString());
  const candidates = useQuery({
    queryKey: [...financeKeys, "replacement-candidates", orderId],
    queryFn: () => listOrders({ status: "draft", page: 1, pageSize: 100 }),
  });
  const replacement = useQuery({
    queryKey: [...financeKeys, "replacement", replacementId],
    queryFn: () => getOrder(replacementId),
    enabled: !!replacementId,
  });
  const receipts = [
    ...new Map(
      allocations
        .filter((a) => a.paymentId)
        .map((a) => [a.paymentId!, a.paymentReference]),
    ).entries(),
  ].filter(
    ([id]) =>
      allocations
        .filter((a) => a.paymentId === id)
        .reduce((sum, a) => sum + cents(a.amount), 0n) > 0n,
  );
  const reversals = (): PaymentReversalInput[] =>
    reverseIds.map((paymentId) => ({
      paymentId,
      reasonKind: kind,
      reason,
      occurredAt,
      externalReference: correctionReference,
    }));
  return (
    <Tile>
      <h2>Full reversal or replacement</h2>
      <Stack gap={5}>
        <TextInput
          id="order-reversal-reason"
          labelText="Reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {canReversePayments && receipts.length > 0 && (
          <>
            <p>
              V1 reverses whole receipts. Select only payments actually refunded
              or corrected.
            </p>
            {receipts.map(([id, ref]) => (
              <Checkbox
                key={id}
                id={"reverse-" + id}
                labelText={`Reverse ${ref} in the same operation`}
                checked={reverseIds.includes(id)}
                onChange={(_, v) =>
                  setReverseIds(
                    v.checked
                      ? [...reverseIds, id]
                      : reverseIds.filter((x) => x !== id),
                  )
                }
              />
            ))}
            <Select
              id="correction-kind"
              labelText="Payment correction"
              value={kind}
              onChange={(e) =>
                setKind(e.target.value as PaymentReversalInput["reasonKind"])
              }
            >
              <SelectItem value="refund" text="Actual refund" />
              <SelectItem
                value="recording_error"
                text="Recording error — no new money movement"
              />
              <SelectItem
                value="external_correction"
                text="External accounting correction"
              />
            </Select>
            <TextInput
              id="correction-reference"
              labelText="Card/external correction reference"
              value={correctionReference}
              onChange={(e) => setCorrectionReference(e.target.value)}
            />
          </>
        )}
        {status === "finalized" && (
          <Button
            kind="danger"
            disabled={!reason || pending}
            onClick={() =>
              run(() =>
                reverseOrder(
                  orderId,
                  command("reverse", { reason, reversals: reversals() }),
                ),
              )
            }
          >
            Reverse all charges
          </Button>
        )}
        {canCarry && (
          <>
            <Select
              id="replacement-id"
              labelText="Replacement draft"
              value={replacementId}
              onChange={(e) => setReplacementId(e.target.value)}
            >
              <SelectItem value="" text="Choose a replacement draft" />
              {candidates.data?.items
                .filter((o) => o.replacesOrderId === orderId)
                .map((o) => (
                  <SelectItem key={o.id} value={o.id} text={o.reference} />
                ))}
            </Select>
            {replacement.data && (
              <p>
                {replacement.data.reference} ·{" "}
                {formatMoney(replacement.data.totalAmount)}. Remaining original
                receipts will transfer without money movement.
              </p>
            )}
            <Checkbox
              id="replacement-payment"
              labelText="Record an additional confirmed cash/card payment with replacement"
              checked={addPayment}
              onChange={(_, v) => {
                setAddPayment(v.checked);
                setNewPayment(undefined);
              }}
            />
            {addPayment && (
              <PaymentForm
                defaultAmount={replacement.data?.totalAmount || ""}
                pending={pending}
                error={null}
                onSubmit={setNewPayment}
              />
            )}{" "}
            {newPayment && (
              <p>
                Staged {newPayment.method} receipt: € {newPayment.amount}. It
                commits with the replacement.
              </p>
            )}
            <Button
              disabled={
                !replacement.data ||
                !reason ||
                pending ||
                (addPayment && !newPayment)
              }
              onClick={() =>
                run(() =>
                  replaceOrder(
                    orderId,
                    command("replace", {
                      replacementOrderId: replacementId,
                      expectedReplacementVersion: replacement.data!.version,
                      reason,
                      reversals: reversals(),
                      payments: newPayment ? [newPayment] : [],
                    }),
                  ),
                )
              }
            >
              Commit replacement and carry payments
            </Button>
            <p>
              If the new total is lower than the remaining payments, explicitly
              reverse whole receipts first. No customer credit is created.
            </p>
          </>
        )}
        <span className="visually-hidden">Order version {version}</span>
      </Stack>
    </Tile>
  );
}
