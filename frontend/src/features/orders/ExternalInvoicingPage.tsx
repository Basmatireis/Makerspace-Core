import {
  Button,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
  Tile,
  Pagination,
  StructuredListWrapper,
  StructuredListBody,
  StructuredListRow,
  StructuredListCell,
} from "@carbon/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Controller, useForm } from "react-hook-form";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  cancelExternalInvoiceRequest,
  confirmExternalInvoiceCancellation,
  correctExternalInvoiceReference,
  getExternalInvoiceRequest,
  forwardExternalInvoiceRequest,
  listExternalInvoiceRequests,
  returnExternalInvoiceRequest,
  requestExternalInvoiceCancellation,
  submitExternalInvoiceRequest,
  updateExternalInvoiceRequest,
} from "../../api/generated/external-invoicing/external-invoicing";
import {
  getOrganizationInvoicingRequirements,
  updateOrganizationInvoicingRequirements,
  listOrganizations,
} from "../../api/generated/organizations/organizations";
import type {
  InvoiceRequestCommand,
  InvoiceRequestDetails,
} from "../../api/generated/models";
import { PageShell } from "../../app/PageShell";
import { DestructiveActionDialog } from "../../app/DestructiveActionDialog";
import { formatDate } from "../../app/dateTime";
import { DateInput } from "../../app/DateInput";
import { ErrorState, FullPageLoading } from "../../app/PageState";
import { useCurrentUser } from "../auth/auth";
import { hasPermission, PermissionId } from "../auth/permissions";
import { FinancialError } from "./shared";
import { financeKeys, useOperationKeys } from "./operations";
import { formatMoney } from "./formatting";
import { useState } from "react";

const labels: Record<string, string> = {
  draft: "Draft",
  submitted: "Awaiting approval",
  issued: "Issued (forwarded to wiRef)",
  cancellation_requested: "External correction requested",
  cancelled: "Cancelled / externally reconciled",
};
export function ExternalInvoicingPage() {
  const [params, setParams] = useSearchParams();
  const page = Number(params.get("page") || 1),
    pageSize = Number(params.get("pageSize") || 25);
  const filters = { page, pageSize, status: params.get("status") || undefined };
  const query = useQuery({
    placeholderData: keepPreviousData,
    queryKey: [...financeKeys, "invoice-list", filters],
    queryFn: () => listExternalInvoiceRequests(filters),
  });
  if (query.isPending)
    return <FullPageLoading label="Loading external invoicing" />;
  if (query.isError)
    return (
      <ErrorState
        message="Requests could not be loaded."
        onRetry={() => query.refetch()}
      />
    );
  return (
    <PageShell
      title="External invoicing"
      description="Prepare requests for wiRef. Makerspace-Core does not issue invoices."
      width="wide"
    >
      <Stack gap={6}>
        <Select
          id="request-filter"
          labelText="Request state"
          value={filters.status || ""}
          onChange={(e) => {
            const next = new URLSearchParams(params);
            next.set("status", e.target.value);
            next.set("page", "1");
            setParams(next, { replace: true });
          }}
        >
          <SelectItem value="" text="All requests" />
          {Object.entries(labels).map(([v, l]) => (
            <SelectItem key={v} value={v} text={l} />
          ))}
        </Select>
        <StructuredListWrapper>
          <StructuredListBody>
            {query.data.items.map((r) => (
              <StructuredListRow key={r.id}>
                <StructuredListCell>
                  <Link to={`/external-invoicing/${r.id}`}>{r.reference}</Link>
                </StructuredListCell>
                <StructuredListCell>{r.orderReference}</StructuredListCell>
                <StructuredListCell>{labels[r.state]}</StructuredListCell>
                <StructuredListCell>
                  {formatMoney(r.requestedAmount)}
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
        <InvoicingRequirementsEditor />
      </Stack>
    </PageShell>
  );
}
export function ExternalInvoiceDetailPage() {
  const { requestId = "" } = useParams();
  return (
    <ExternalInvoiceDetailPageContent key={requestId} requestId={requestId} />
  );
}

function ExternalInvoiceDetailPageContent({
  requestId,
}: {
  requestId: string;
}) {
  const user = useCurrentUser();
  const client = useQueryClient();
  const key = useOperationKeys();
  const [externalReference, setReference] = useState("");
  const [reason, setReason] = useState("");
  const [reconciliationKind, setKind] =
    useState<InvoiceRequestCommand["reconciliationKind"]>("cancellation");
  const [effectiveDate, setEffectiveDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [confirmation, setConfirmation] = useState<
    "request-cancel" | "confirm-cancel" | "cancel" | undefined
  >();
  const query = useQuery({
    queryKey: [...financeKeys, "invoice", requestId],
    queryFn: () => getExternalInvoiceRequest(requestId),
  });
  const form = useForm<InvoiceRequestDetails>({ values: query.data?.details });
  const mutation = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: async () => {
      setConfirmation(undefined);
      await client.invalidateQueries({ queryKey: financeKeys });
    },
  });
  if (query.isPending) return <FullPageLoading label="Loading request" />;
  if (query.isError)
    return (
      <ErrorState
        message="Request could not be loaded."
        onRetry={() => query.refetch()}
      />
    );
  const r = query.data;
  const canManage =
    hasPermission(user, PermissionId.external_invoice_requestsmanage) &&
    hasPermission(user, PermissionId.ordersread);
  const canApprove =
    hasPermission(user, PermissionId.external_invoice_requestsapprove) &&
    hasPermission(user, PermissionId.ordersread);
  const canEdit =
    (r.state === "draft" && canManage) ||
    (r.state === "submitted" && canApprove);
  const run = (fn: () => Promise<unknown>) => mutation.mutate(fn);
  const command = (action: string): InvoiceRequestCommand => {
    const input = {
      expectedVersion: r.version,
      externalReference,
      reason,
      reconciliationKind:
        action === "confirm-cancel" ? reconciliationKind : undefined,
      effectiveAt: `${effectiveDate}T12:00:00Z`,
      amount: r.requestedAmount,
    };
    return { ...input, operationKey: key(action, input) };
  };
  return (
    <PageShell
      title={r.reference}
      description={labels[r.state]}
      breadcrumbs={[
        { label: "External invoicing", to: "/external-invoicing" },
        { label: r.reference },
      ]}
    >
      <Stack gap={6}>
        <FinancialError error={mutation.error} />
        <Tile>
          <p>
            {r.orderId ? (
              <Link to={`/orders/${r.orderId}`}>{r.orderReference}</Link>
            ) : (
              r.orderReference
            )}{" "}
            · {formatMoney(r.requestedAmount)} · wiRef
          </p>
          <p>
            Draft requests are submitted for approval. Once approved and
            forwarded to wiRef the request is issued and the order is settled by
            an invoice payment for its open balance. Already paid by cash or
            card: {formatMoney(r.alreadyPaid)}.
          </p>
          {r.supersedesRequestId && (
            <p>
              Supersedes{" "}
              <Link to={`/external-invoicing/${r.supersedesRequestId}`}>
                previous request
              </Link>
              .
            </p>
          )}
        </Tile>
        <Tile>
          <h2>Recipient and service snapshot</h2>
          <form
            onSubmit={form.handleSubmit((v) =>
              run(() =>
                updateExternalInvoiceRequest(r.id, {
                  expectedVersion: r.version,
                  details: v,
                }),
              ),
            )}
          >
            <Stack gap={5}>
              {(
                [
                  "recipientName",
                  "addressLine1",
                  "addressLine2",
                  "postalCode",
                  "locality",
                  "region",
                  "countryCode",
                  "contactName",
                  "contactChannel",
                  "purchaseOrderReference",
                ] as const
              ).map((n) => (
                <TextInput
                  key={n}
                  id={"invoice-" + n}
                  labelText={
                    {
                      recipientName: "Invoice recipient",
                      addressLine1: "Billing address",
                      addressLine2: "Address line 2",
                      postalCode: "Postal code",
                      locality: "Locality",
                      region: "Region",
                      countryCode: "Country code",
                      contactName: "Organization contact person",
                      contactChannel: "Contact email/phone (optional)",
                      purchaseOrderReference: "Purchase order reference",
                    }[n]
                  }
                  readOnly={!canEdit}
                  {...form.register(n)}
                />
              ))}
              {(["serviceStartsOn", "serviceEndsOn"] as const).map((n) =>
                canEdit ? (
                  <Controller
                    key={n}
                    name={n}
                    control={form.control}
                    render={({ field }) => (
                      <DateInput
                        id={"invoice-" + n}
                        labelText={
                          n === "serviceStartsOn"
                            ? "Service period from"
                            : "Service period through"
                        }
                        value={field.value || ""}
                        onChange={field.onChange}
                      />
                    )}
                  />
                ) : (
                  <p key={n}>
                    {n === "serviceStartsOn"
                      ? "Service period from"
                      : "Service period through"}
                    : {r.details[n] ? formatDate(r.details[n]) : "—"}
                  </p>
                ),
              )}
              <TextArea
                id="invoice-service"
                labelText="Type/description of service"
                readOnly={!canEdit}
                {...form.register("serviceDescription")}
              />
              {r.requirePurchaseOrderReference && (
                <p>
                  A purchase order reference is required by this recipient’s
                  organization configuration.
                </p>
              )}
              {canEdit && (
                <Button type="submit" disabled={mutation.isPending}>
                  Save request details
                </Button>
              )}
              {r.state === "draft" && canManage && (
                <>
                  <Button
                    kind="secondary"
                    disabled={mutation.isPending}
                    onClick={() =>
                      run(() =>
                        submitExternalInvoiceRequest(r.id, command("submit")),
                      )
                    }
                  >
                    Submit for approval
                  </Button>
                  <p>
                    Save details before submitting. The readiness checklist has
                    to be complete.
                  </p>
                </>
              )}
            </Stack>
          </form>
        </Tile>
        {(canManage || canApprove) && r.state !== "cancelled" && (
          <Tile>
            <h2>External workflow</h2>
            <Stack gap={5}>
              {r.state === "submitted" && canApprove && (
                <>
                  <p>
                    Copy the reviewed data to wiRef through your normal process,
                    then mark the request as forwarded. The wiRef invoice number
                    is optional and can be added later.
                  </p>
                  <TextInput
                    id="return-reason"
                    labelText="Comment for returning (required to return)"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                  <Button
                    disabled={mutation.isPending}
                    onClick={() =>
                      run(() =>
                        forwardExternalInvoiceRequest(r.id, {
                          operationKey: command("forward").operationKey,
                          expectedVersion: r.version,
                        }),
                      )
                    }
                  >
                    Mark forwarded to wiRef
                  </Button>
                  <Button
                    kind="secondary"
                    disabled={!reason.trim() || mutation.isPending}
                    onClick={() =>
                      run(() =>
                        returnExternalInvoiceRequest(r.id, {
                          operationKey: command("return").operationKey,
                          expectedVersion: r.version,
                          reason,
                        }),
                      )
                    }
                  >
                    Return for correction
                  </Button>
                </>
              )}
              {["issued", "cancellation_requested"].includes(r.state) && (
                <>
                  <TextInput
                    id="issued-reference"
                    labelText="External invoice/correction reference"
                    value={externalReference}
                    onChange={(e) => setReference(e.target.value)}
                  />
                  <DateInput
                    id="issued-date"
                    labelText="External action date"
                    value={effectiveDate}
                    onChange={setEffectiveDate}
                  />
                  <TextInput
                    id="invoice-reason"
                    labelText="Reason / accounting context"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </>
              )}
              {r.state === "issued" && (
                <Button
                  kind="secondary"
                  disabled={!externalReference || mutation.isPending}
                  onClick={() =>
                    run(() =>
                      correctExternalInvoiceReference(
                        r.id,
                        command("correct-reference"),
                      ),
                    )
                  }
                >
                  Add or correct invoice number (a correction needs a reason)
                </Button>
              )}
              {r.state === "issued" && canManage && (
                <Button
                  kind="danger--tertiary"
                  disabled={mutation.isPending}
                  onClick={() => { mutation.reset(); setConfirmation("request-cancel"); }}
                >
                  Request external correction
                </Button>
              )}
              {r.state === "cancellation_requested" && (
                <>
                  <Select
                    id="external-correction-kind"
                    labelText="External accounting procedure"
                    value={reconciliationKind}
                    onChange={(e) =>
                      setKind(
                        e.target
                          .value as InvoiceRequestCommand["reconciliationKind"],
                      )
                    }
                  >
                    {[
                      "cancellation",
                      "credit_note",
                      "corrected_invoice",
                      "reallocation",
                      "other",
                    ].map((v) => (
                      <SelectItem
                        key={v}
                        value={v}
                        text={v.replaceAll("_", " ")}
                      />
                    ))}
                  </Select>
                  <Button
                    disabled={!externalReference || mutation.isPending}
                    onClick={() => { mutation.reset(); setConfirmation("confirm-cancel"); }}
                  >
                    Record external reconciliation evidence
                  </Button>
                  <p>
                    Recording the reconciliation reverses the invoice payment that
                    settled the order, which reopens its balance. The accounting procedure may be a credit
                    note, corrected invoice, reallocation, or cancellation.
                  </p>
                </>
              )}
              {((r.state === "draft" && canManage) || (r.state === "submitted" && canApprove)) && (
                <Button
                  kind="danger--tertiary"
                  disabled={mutation.isPending}
                  onClick={() => { mutation.reset(); setConfirmation("cancel"); }}
                >
                  Cancel request
                </Button>
              )}
            </Stack>
          </Tile>
        )}
        <Tile>
          <h2>Handoff items</h2>
          {r.itemSummary.map((i) => (
            <p key={i.id}>
              {i.description} · {i.quantity} {i.unit} · {formatMoney(i.amount)}
            </p>
          ))}
        </Tile>
        <Tile>
          <h2>External evidence history</h2>
          {r.events.map((e) => (
            <p key={e.id}>
              {[
                formatDate(e.effectiveAt),
                e.kind.replaceAll("_", " "),
                e.externalReference,
                e.reconciliationKind.replaceAll("_", " "),
                e.reason,
                e.recordedBy?.displayName,
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          ))}
        </Tile>
        <DestructiveActionDialog
          open={Boolean(confirmation)}
          title={confirmation === "request-cancel"
            ? "Request an external correction?"
            : confirmation === "confirm-cancel"
              ? "Record external reconciliation?"
              : "Cancel external invoice request?"}
          confirmLabel={confirmation === "request-cancel"
            ? "Request correction"
            : confirmation === "confirm-cancel"
              ? "Record reconciliation"
              : "Cancel request"}
          pending={mutation.isPending}
          error={mutation.error?.message}
          onClose={() => { setConfirmation(undefined); mutation.reset(); }}
          onConfirm={() => {
            if (confirmation === "request-cancel") {
              run(() => requestExternalInvoiceCancellation(r.id, command("request-cancel")));
            } else if (confirmation === "confirm-cancel") {
              run(() => confirmExternalInvoiceCancellation(r.id, command("confirm-cancel")));
            } else if (confirmation === "cancel") {
              run(() => cancelExternalInvoiceRequest(r.id, command("cancel")));
            }
          }}
        >
          <p>{confirmation === "request-cancel"
            ? "This records that the issued request now requires correction in wiRef. Existing request and external evidence remain in history."
            : confirmation === "confirm-cancel"
              ? `This appends ${(reconciliationKind ?? "cancellation").replaceAll("_", " ")} evidence with reference ${externalReference}. It does not erase the invoice request, payment, or accounting history.`
              : "This cancels the request before it was issued. The order remains and the request record stays in history; no external invoice is changed."}</p>
          {reason && <p>Reason: {reason}</p>}
        </DestructiveActionDialog>
      </Stack>
    </PageShell>
  );
}
export function InvoicingRequirementsEditor() {
  const [id, setId] = useState("");
  const user = useCurrentUser();
  const client = useQueryClient();
  const canConfigure =
    hasPermission(user, PermissionId.organizationsmanage) &&
    hasPermission(user, PermissionId.organizationsread) &&
    hasPermission(user, PermissionId.ordersread);
  const organizations = useQuery({
    queryKey: [...financeKeys, "organizations"],
    queryFn: () => listOrganizations({ page: 1, pageSize: 100 }),
    enabled: canConfigure,
  });
  const policy = useQuery({
    queryKey: [...financeKeys, "policy", id],
    queryFn: () => getOrganizationInvoicingRequirements(id),
    enabled: !!id && canConfigure,
  });
  const mutation = useMutation({
    mutationFn: (value: boolean) =>
      updateOrganizationInvoicingRequirements(id, {
        expectedVersion: policy.data!.version,
        requirePurchaseOrderReference: value,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: financeKeys }),
  });
  if (!canConfigure) return null;
  return (
    <Tile>
      <h2>Organization invoicing requirements</h2>
      <Stack gap={5}>
        <Select
          id="policy-organization"
          labelText="Organization"
          value={id}
          onChange={(e) => setId(e.target.value)}
        >
          <SelectItem value="" text="Select organization" />
          {organizations.data?.items.map((o) => (
            <SelectItem key={o.id} value={o.id} text={o.name} />
          ))}
        </Select>
        {policy.data && (
          <Select
            id="purchase-order-required"
            labelText="External invoicing requires a purchase order reference"
            value={policy.data.requirePurchaseOrderReference ? "yes" : "no"}
            disabled={mutation.isPending}
            onChange={(e) => mutation.mutate(e.target.value === "yes")}
          >
            <SelectItem value="no" text="No" />
            <SelectItem value="yes" text="Yes" />
          </Select>
        )}
        <FinancialError error={mutation.error} />
      </Stack>
    </Tile>
  );
}
