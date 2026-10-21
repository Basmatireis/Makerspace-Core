import { useState } from 'react';
import { useForm } from 'react-hook-form';
import {
  Accordion,
  AccordionItem,
  Button,
  ContainedList,
  ContainedListItem,
  InlineNotification,
  OverflowMenu,
  OverflowMenuItem,
  ProgressIndicator,
  ProgressStep,
  Stack,
  Tile,
} from '@carbon/react';
import { Copy, Receipt } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { updateExternalInvoiceRequest } from '../../api/generated/external-invoicing/external-invoicing';
import type { ExternalInvoiceRequest, Order } from '../../api/generated/models';
import { LinkifiedText } from '../../app/RefLink';
import { RichNotification } from '../../app/RichNotification';
import { formatDate, formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useNotify } from '../machinelogbook/shared/toasts';
import { organizationRequirementsQuery } from '../organizations/queries';
import { useMediaQuery } from './useMediaQuery';
import { requestEventLabel, requestStateLabel, reconciliationLabels } from './labels';
import {
  cancellationOf,
  INVOICE_STEPS,
  invoiceNumberOf,
  invoiceRequestBlocker,
  isPaid,
  latestReturn,
  requestNext,
  requestProgress,
  requestReadiness,
} from './logic';
import { formatCents, toCents } from './money';
import { orderRequestsQuery, requestQuery, useFinanceMutation } from './queries';
import { ReadinessChecklist } from './ReadinessChecklist';
import { RecipientFields } from './RecipientFields';
import { toRecipientValues, toRequestDetails, type RecipientValues } from './recipientValues';
import { RequestDialog, type RequestDialogKind } from './RequestDialogs';
import { RequestInvoiceModal } from './RequestInvoiceModal';
import { RequestStateTag } from './status';
import { WiRefDeliveryStatus } from './WiRefDeliveryStatus';

function Frozen({ request }: { request: ExternalInvoiceRequest }) {
  const details = request.details;
  const period = details.serviceStartsOn
    ? `${formatDate(`${details.serviceStartsOn}T12:00:00Z`)} to ${details.serviceEndsOn ? formatDate(`${details.serviceEndsOn}T12:00:00Z`) : '—'}`
    : '—';
  return (
    <dl className="mj-facts sales-facts">
      <div>
        <dt>Recipient</dt>
        <dd>{details.recipientName || '—'}</dd>
      </div>
      <div>
        <dt>Address</dt>
        <dd>
          {[details.addressLine1, `${details.postalCode ?? ''} ${details.locality ?? ''}`.trim(), details.countryCode]
            .filter(Boolean)
            .join(', ') || '—'}
        </dd>
      </div>
      {details.contactName && (
        <div>
          <dt>Contact person</dt>
          <dd>{details.contactName}</dd>
        </div>
      )}
      {details.purchaseOrderReference && (
        <div>
          <dt>Purchase order</dt>
          <dd>{details.purchaseOrderReference}</dd>
        </div>
      )}
      <div>
        <dt>Service period</dt>
        <dd>{period}</dd>
      </div>
      <div>
        <dt>Description</dt>
        <dd>{details.serviceDescription || '—'}</dd>
      </div>
    </dl>
  );
}

/**
 * The invoice of an order, issued by wiRef: progress, the next step with every action of the state, recipient details, checklist and history.
 * The latest request is shown in full, also when it was cancelled; earlier ones are listed collapsed.
 * Without permission to read requests only the state of the latest request is shown.
 */
export function InvoiceSection({ order }: { order: Order }) {
  const user = useCurrentUser();
  const canRead = hasPermission(user, PermissionId.external_invoice_requestsread);
  const latestId = order.latestExternalRequestId;
  const query = useQuery({ ...requestQuery(latestId ?? ''), enabled: !!latestId && canRead });
  if (!latestId) return null;
  if (!canRead) {
    return (
      <Tile id="invoice" className="sales-invoice">
        <h2 className="mj-section-title mj-inline">
          Invoice <RequestStateTag state={order.latestExternalRequestState ?? ''} size="md" />
        </h2>
        <p className="mj-secondary">
          {order.latestExternalRequestReference}. Recipient details need the permission to read invoice requests.
        </p>
      </Tile>
    );
  }
  if (query.isPending)
    return (
      <Tile id="invoice">
        <InlineLoadingState label="Loading invoice" />
      </Tile>
    );
  if (query.isError) return <ErrorState message="The invoice could not be loaded." onRetry={() => query.refetch()} />;
  return <InvoiceContent key={query.data.id} order={order} request={query.data} />;
}

/** The events of one request, newest first. */
function RequestHistory({ events }: { events: ExternalInvoiceRequest['events'] }) {
  return (
    <ContainedList label="History" kind="disclosed" className="sales-timeline">
      {events.length === 0 && <ContainedListItem>Nothing has happened yet.</ContainedListItem>}
      {events.map((event) => (
        <ContainedListItem key={event.id} renderIcon={Receipt}>
          <span className="mj-cell-stack">
            <strong>{requestEventLabel[event.kind] ?? event.kind.replaceAll('_', ' ')}</strong>
            {event.reason && (
              <span>
                <LinkifiedText text={event.reason} targets={{}} />
              </span>
            )}
            {(event.reconciliationKind || event.externalReference) && (
              <span className="mj-secondary">
                {[
                  event.reconciliationKind &&
                    (reconciliationLabels[event.reconciliationKind as keyof typeof reconciliationLabels]?.label ??
                      event.reconciliationKind),
                  event.externalReference && `Reference ${event.externalReference}`,
                  event.effectiveAt && `effective ${formatDate(event.effectiveAt)}`,
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            )}
            <span className="mj-secondary">
              {event.recordedBy?.displayName ?? 'Unknown'} · {formatDateTime(event.recordedAt)}
            </span>
          </span>
        </ContainedListItem>
      ))}
    </ContainedList>
  );
}

/** Requests that came before the latest one (cancelled and requested again), collapsed. Their data and history stay readable. */
function EarlierRequests({ orderId, latestId }: { orderId: string; latestId: string }) {
  const query = useQuery(orderRequestsQuery(orderId));
  const earlier = (query.data ?? []).filter((request) => request.id !== latestId);
  if (earlier.length === 0) return null;
  return (
    <Accordion size="md">
      <AccordionItem title={`Earlier requests (${earlier.length})`}>
        <Accordion size="md">
          {earlier.map((request) => (
            <AccordionItem
              key={request.id}
              title={`${request.reference} · ${requestStateLabel[request.state] ?? request.state} · ${formatDate(request.createdAt)}`}
            >
              <Stack gap={5}>
                <dl className="mj-facts sales-facts">
                  <div>
                    <dt>Invoice amount</dt>
                    <dd>{formatCents(toCents(request.requestedAmount))}</dd>
                  </div>
                </dl>
                <Frozen request={request} />
                <RequestHistory events={[...request.events].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))} />
              </Stack>
            </AccordionItem>
          ))}
        </Accordion>
      </AccordionItem>
    </Accordion>
  );
}

function InvoiceContent({ order, request }: { order: Order; request: ExternalInvoiceRequest }) {
  const user = useCurrentUser();
  const notify = useNotify();
  const narrow = useMediaQuery('(max-width: 41.98rem)');
  const [dialog, setDialog] = useState<RequestDialogKind | 'again' | null>(null);
  const can = (permission: PermissionId) => hasPermission(user, permission);
  const canManage = can(PermissionId.external_invoice_requestsmanage);
  const canApprove = can(PermissionId.external_invoice_requestsapprove);
  const draft = request.state === 'draft';
  const awaiting = request.state === 'submitted';
  const cancelled = request.state === 'cancelled';
  const cancellation = cancelled ? cancellationOf(request) : null;
  // Staff edit the draft; while the request awaits approval only an approver edits it.
  const editable = (draft && canManage) || (awaiting && canApprove);
  const form = useForm<RecipientValues>({ values: toRecipientValues(request.details) });
  const dirty = form.formState.isDirty;
  const live = editable ? toRequestDetails(form.watch(), request.details) : request.details;
  const isOrganization = order.customerKind === 'organization';
  const paid = isPaid(order);
  const progress = requestProgress(request);
  const invoiceNumber = invoiceNumberOf(request);
  const returned = latestReturn(request);
  // The organization's purchase-order flag is shown when the request was made before the flag changed.
  const requirements = useQuery({
    ...organizationRequirementsQuery(order.customer?.id ?? ''),
    enabled: isOrganization && !!order.customer && draft,
  });
  const needsPurchaseOrder =
    request.requirePurchaseOrderReference || !!requirements.data?.requirePurchaseOrderReference;
  const readiness = requestReadiness(live, order.customerKind, needsPurchaseOrder);
  const ready = readiness.every((item) => item.ok);

  const save = useFinanceMutation(
    () =>
      updateExternalInvoiceRequest(request.id, {
        expectedVersion: request.version,
        details: toRequestDetails(form.getValues(), request.details),
      }),
    () => {
      notify({ kind: 'success', title: 'Recipient details saved' });
    },
  );

  let primary: { label: string; disabled?: boolean; run: () => void } | null = null;
  let secondary: { label: string; run: () => void } | null = null;
  if (canManage) {
    if (draft) primary = { label: 'Submit for approval', disabled: !ready || dirty, run: () => setDialog('submit') };
    else if (request.state === 'cancellation_requested')
      primary = { label: 'Confirm cancellation', run: () => setDialog('confirm-cancellation') };
  }
  if (cancelled && canManage && invoiceRequestBlocker(order) === null)
    primary = { label: 'Request invoice again', run: () => setDialog('again') };
  if (awaiting && canApprove) {
    primary = { label: 'Copy for wiRef', disabled: !ready || dirty, run: () => setDialog('forward') };
    secondary = { label: 'Return for correction', run: () => setDialog('return') };
  }
  const menu = [
    ((draft && canManage) || (awaiting && canApprove)) && (
      <OverflowMenuItem key="cancel" itemText="Cancel request" isDelete onClick={() => setDialog('cancel')} />
    ),
    canManage && request.state === 'issued' && (
      <OverflowMenuItem
        key="request-cancellation"
        itemText="Request cancellation…"
        onClick={() => setDialog('request-cancellation')}
      />
    ),
    (canManage || canApprove) && (request.state === 'issued' || request.state === 'cancellation_requested') && (
      <OverflowMenuItem
        key="reference"
        itemText={invoiceNumber ? 'Correct invoice number…' : 'Add wiRef invoice number…'}
        onClick={() => setDialog('reference')}
      />
    ),
  ].filter(Boolean);
  const history = [...request.events].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const requested = toCents(request.requestedAmount);
  const alreadyPaid = toCents(request.alreadyPaid);
  const externalPaid = paid && request.state === 'issued';

  return (
    <Tile id="invoice" className="sales-invoice">
      <div className="sales-invoice__head">
        <h2 className="mj-section-title mj-inline">
          Invoice <RequestStateTag state={request.state} size="md" />
        </h2>
        <span className="mj-inline">
          {secondary && (
            <Button kind="tertiary" size="md" onClick={secondary.run}>
              {secondary.label}
            </Button>
          )}
          {primary && (
            <Button
              kind="primary"
              size="md"
              renderIcon={primary.label === 'Copy for wiRef' ? Copy : undefined}
              disabled={primary.disabled}
              onClick={primary.run}
            >
              {primary.label}
            </Button>
          )}
          {menu.length > 0 && (
            <OverflowMenu aria-label="More invoice actions" iconDescription="More invoice actions" flipped>
              {menu}
            </OverflowMenu>
          )}
        </span>
      </div>
      {returned && (
        <RichNotification kind="warning" title="Returned for correction" className="sales-invoice__returned">
          <LinkifiedText text={returned.reason} targets={{}} />
          <br />
          <span className="mj-secondary">
            {returned.recordedBy?.displayName ?? 'An approver'} · {formatDateTime(returned.recordedAt)}
          </span>
        </RichNotification>
      )}
      <ProgressIndicator currentIndex={progress.index} spaceEqually vertical={narrow} className="sales-progress">
        {INVOICE_STEPS.map((label, index) => (
          <ProgressStep
            key={label}
            label={label}
            invalid={progress.invalid && index === progress.index}
            secondaryLabel={progress.invalid && index === progress.index ? requestStateLabel[request.state] : undefined}
          />
        ))}
      </ProgressIndicator>
      <p className="mj-secondary sales-top-gap">
        {request.reference} ·{' '}
        {cancelled ? 'This request is cancelled' : `Next step: ${requestNext(request, paid, ready)}`}
      </p>

      <dl className="mj-facts sales-facts sales-top-gap">
        <div>
          <dt>Invoice amount</dt>
          <dd>
            {formatCents(requested)}
            {toCents(order.netCharge) !== requested && ` (the order is now ${formatCents(toCents(order.netCharge))})`}
          </dd>
        </div>
        <div>
          <dt>Already paid (cash or card)</dt>
          <dd>
            {formatCents(alreadyPaid)}
            {draft && alreadyPaid > 0 ? ' · follows payments until it is submitted' : ''}
          </dd>
        </div>
        <div>
          <dt>{request.state === 'issued' ? 'Settled by this invoice' : 'Open on the order'}</dt>
          <dd>
            {request.state === 'issued'
              ? formatCents(Math.max(0, requested - alreadyPaid))
              : formatCents(toCents(order.outstandingAmount))}
          </dd>
        </div>
        {invoiceNumber && (
          <div>
            <dt>wiRef invoice number</dt>
            <dd>
              {invoiceNumber.externalReference}
              {invoiceNumber.effectiveAt && (
                <span className="mj-secondary"> · {formatDate(invoiceNumber.effectiveAt)}</span>
              )}
            </dd>
          </div>
        )}
        {!invoiceNumber && request.state === 'issued' && (
          <div>
            <dt>wiRef invoice number</dt>
            <dd>
              {canManage || canApprove ? (
                <Button kind="ghost" size="sm" onClick={() => setDialog('reference')}>
                  Add wiRef invoice number
                </Button>
              ) : (
                <span className="mj-secondary">Not recorded yet</span>
              )}
            </dd>
          </div>
        )}
      </dl>

      <Stack gap={5} className="sales-top-gap">
        {cancelled && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="This request is cancelled"
            subtitle={[
              cancellation?.reconciliationKind &&
                (reconciliationLabels[cancellation.reconciliationKind as keyof typeof reconciliationLabels]?.label ??
                  cancellation.reconciliationKind),
              cancellation?.externalReference && `Cancellation reference ${cancellation.externalReference}`,
              cancellation?.reason,
              cancellation &&
                `${cancellation.recordedBy?.displayName ?? 'Unknown'}, ${formatDateTime(cancellation.recordedAt)}`,
              'It no longer counts for the order.',
            ]
              .filter(Boolean)
              .join(' · ')}
          />
        )}
        {request.state === 'cancellation_requested' && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="Waiting for the cancellation in wiRef"
            subtitle="Cash and card stay switched off for the order. Once wiRef cancelled or corrected the invoice, confirm it with the reference."
          />
        )}
        {request.state === 'issued' && paid && (
          <InlineNotification
            kind="success"
            lowContrast
            hideCloseButton
            title="Issued, the order is paid"
            subtitle={`${order.reference} counts as paid: the invoice settles the balance. The customer pays wiRef by bank transfer outside Core.`}
          />
        )}
        <WiRefDeliveryStatus request={request} />
        {awaiting && !canApprove && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Waiting for approval"
            subtitle="An approver checks the data and forwards it to wiRef. Until then the request is read-only."
          />
        )}
        {awaiting && canApprove && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Approval needed"
            subtitle="Check the data and correct it here if needed. Forwarding mails the data to wiRef as PDF. Or return the request with a comment."
          />
        )}
        {!canManage && !canApprove && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Read-only"
            subtitle="Changing an invoice request needs the permission to manage invoice requests."
          />
        )}
        {(draft || (awaiting && canApprove)) && (
          <ReadinessChecklist
            label={draft ? 'Ready to submit?' : 'Ready to forward?'}
            items={readiness}
            hint="set under Directory › Organizations"
          />
        )}
        {editable && dirty && <p className="mj-secondary">Save the details to continue.</p>}
        <Accordion size="md">
          <AccordionItem title="Recipient and service" open={editable}>
            {editable ? (
              <Stack gap={5}>
                <RecipientFields
                  form={form}
                  idPrefix={`recipient-${request.id}`}
                  organization={isOrganization}
                  requiresPurchaseOrder={needsPurchaseOrder}
                  disabled={save.isPending}
                />
                {save.error && (
                  <InlineNotification
                    kind="error"
                    lowContrast
                    hideCloseButton
                    title="Details not saved"
                    subtitle={save.error.message}
                  />
                )}
                <div className="mj-inline">
                  <Button kind="primary" size="md" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
                    {save.isPending ? 'Saving…' : 'Save details'}
                  </Button>
                  <Button kind="ghost" size="md" disabled={!dirty || save.isPending} onClick={() => form.reset()}>
                    Discard changes
                  </Button>
                  {dirty && <span className="mj-secondary">Unsaved changes</span>}
                  {!dirty && awaiting && <span className="mj-secondary">Changes are recorded in the audit log.</span>}
                </div>
              </Stack>
            ) : (
              <>
                <Frozen request={request} />
                {(request.state === 'issued' || request.state === 'cancellation_requested') && (
                  <p className="mj-secondary sales-top-gap">
                    These details are frozen. To change them, cancel the request and request the invoice again.
                  </p>
                )}
              </>
            )}
          </AccordionItem>
          <AccordionItem title={`History (${history.length})`}>
            <RequestHistory events={history} />
          </AccordionItem>
        </Accordion>
        {request.supersedesRequestId && <EarlierRequests orderId={order.id} latestId={request.id} />}
      </Stack>
      {dialog === 'again' && <RequestInvoiceModal order={order} onClose={() => setDialog(null)} />}
      {dialog && dialog !== 'again' && (
        <RequestDialog
          kind={dialog}
          request={request}
          customerKind={order.customerKind}
          requirePurchaseOrder={needsPurchaseOrder}
          externalPaid={externalPaid}
          onClose={() => setDialog(null)}
        />
      )}
    </Tile>
  );
}
