import { useState } from 'react';
import { Button, ContainedList, ContainedListItem, InlineNotification, Link as CarbonLink, OverflowMenu, OverflowMenuItem, ProgressIndicator, ProgressStep, Tag, Tile } from '@carbon/react';
import { CheckmarkFilled, Misuse, Receipt } from '@carbon/icons-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { useStore } from '../../store';
import { LinkNotification } from '../components/LinkNotification';
import { RecipientDetailsForm } from '../components/RecipientDetailsForm';
import { RequirePermission } from '../components/RequirePermission';
import { RequestDialog, type RequestDialogKind } from '../dialogs/RequestDialogs';
import { RecordPaymentModal } from '../dialogs/RecordPaymentModal';
import { invoiceRequestBlocker } from '../engine';
import { formatDate, formatDateTime, formatEur } from '../format';
import { reconciliationLabels, requestEventLabel, requestStateLabel } from '../labels';
import { requestNext, requestProgress, requestReadiness, type OrderView } from '../logic';
import { OrderStatusTag, RequestStateTag } from '../status';
import { useMediaQuery } from '../useMediaQuery';
import { useSalesData } from '../useSalesData';
import { useSalesMutation } from '../useSalesMutation';
import type { InvoiceRequest, InvoiceRequestDetails } from '../types';
import '../sales.scss';

const crumbs = [{ label: 'Sales & payments', to: '/sales' }, { label: 'Invoicing', to: '/sales/invoicing' }];
const STEPS = ['Draft', 'Ready to submit', 'Submitted', 'Invoice issued', 'Paid'];

function Frozen({ details }: { details: InvoiceRequestDetails }) {
  return (
    <dl className="mj-facts sales-facts">
      <div><dt>Recipient</dt><dd>{details.recipientName || '—'}</dd></div>
      <div><dt>Address</dt><dd>{[details.addressLine1, `${details.postalCode} ${details.locality}`.trim(), details.countryCode].filter(Boolean).join(', ') || '—'}</dd></div>
      {details.contactName && <div><dt>Contact person</dt><dd>{details.contactName}</dd></div>}
      {details.purchaseOrderReference && <div><dt>Purchase order</dt><dd>{details.purchaseOrderReference}</dd></div>}
      <div><dt>Service period</dt><dd>{details.serviceStartsOn ? `${formatDate(`${details.serviceStartsOn}T12:00:00Z`)} to ${details.serviceEndsOn ? formatDate(`${details.serviceEndsOn}T12:00:00Z`) : '—'}` : '—'}</dd></div>
      <div><dt>Description</dt><dd>{details.serviceDescription || '—'}</dd></div>
    </dl>
  );
}

function RequestDetail({ request, order }: { request: InvoiceRequest; order: OrderView | null }) {
  const store = useStore();
  const navigate = useNavigate();
  const narrow = useMediaQuery('(max-width: 41.98rem)');
  const [dialog, setDialog] = useState<RequestDialogKind | 'pay' | null>(null);
  const [live, setLive] = useState<{ details: InvoiceRequestDetails; dirty: boolean }>({ details: request.details, dirty: false });
  const customer = store.customers.find((item) => item.id === order?.customer?.id);
  const organization = customer?.kind === 'organization';
  const canManage = store.can('external_invoice_requests.manage');
  const draft = request.state === 'draft';
  const checklist = requestReadiness({ details: draft ? live.details : request.details }, customer);
  const complete = checklist.every((item) => item.ok);
  const paid = order?.settlement === 'paid';
  const progress = requestProgress(request, !!paid);
  const successor = store.requests.find((item) => item.supersedesRequestId === request.id);
  const predecessor = store.requests.find((item) => item.id === request.supersedesRequestId);
  const issuedEvent = [...request.events].reverse().find((event) => event.kind === 'reference_corrected' || event.kind === 'issued');
  const newBlocker = order ? invoiceRequestBlocker(store, order) : 'The order is not available';
  const canRecordPayment = request.state === 'issued' && !!order && order.outstanding > 0 && store.can('payments.record') && store.can('payments.read');
  const prepareAgain = useSalesMutation(() => store.prepareInvoiceRequest(order!.id));

  let primary: { label: string; disabled?: boolean; run: () => void } | null = null;
  if (canManage) {
    if (request.state === 'draft') primary = { label: 'Mark as ready', disabled: !complete || live.dirty, run: () => setDialog('ready') };
    else if (request.state === 'ready') primary = { label: 'Mark as submitted', run: () => setDialog('submitted') };
    else if (request.state === 'submitted') primary = { label: 'Record issued invoice', run: () => setDialog('issued') };
    else if (request.state === 'cancellation_requested') primary = { label: 'Confirm cancellation', run: () => setDialog('confirm-cancellation') };
    else if (request.state === 'cancelled' && !successor && newBlocker === null) primary = { label: 'Prepare a new request', run: () => { void prepareAgain.mutate().then((result) => { if (result.ok) navigate(`/sales/invoicing/${result.value.requestId}`); }); } };
  }
  if (request.state === 'issued' && canRecordPayment) primary = { label: 'Record wiRef payment', run: () => setDialog('pay') };
  const menu = canManage ? [
    (request.state === 'draft' || request.state === 'ready') && <OverflowMenuItem key="cancel" itemText="Cancel request" isDelete onClick={() => setDialog('cancel')} />,
    (request.state === 'submitted' || request.state === 'issued') && <OverflowMenuItem key="request-cancellation" itemText="Request cancellation…" onClick={() => setDialog('request-cancellation')} />,
    (request.state === 'issued' || request.state === 'cancellation_requested') && <OverflowMenuItem key="reference" itemText="Correct invoice reference…" onClick={() => setDialog('correct-reference')} />,
  ].filter(Boolean) : [];

  const history = [...request.events].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <PageShell
      title={request.reference} titleAdornment={<RequestStateTag request={request} size="md" />} width="wide" breadcrumbs={crumbs}
      description={`Invoice request for ${order?.reference ?? request.orderReference}${order ? ` · ${order.customerLabel}` : ''} · ${formatEur(request.requestedAmount)}`}
      actions={<>
        {primary && <Button kind="primary" disabled={primary.disabled || prepareAgain.pending} onClick={primary.run}>{prepareAgain.pending ? 'Preparing…' : primary.label}</Button>}
        {menu.length > 0 && <OverflowMenu aria-label="More request actions" iconDescription="More request actions" flipped>{menu}</OverflowMenu>}
      </>}
    >
      <div className="mj-stack">
        <Tile>
          <ProgressIndicator currentIndex={progress.index} spaceEqually vertical={narrow} className="sales-progress">
            {STEPS.map((label, index) => (
              <ProgressStep key={label} label={label} invalid={progress.invalid && index === progress.index}
                secondaryLabel={progress.invalid && index === progress.index ? requestStateLabel[request.state] : undefined} />
            ))}
          </ProgressIndicator>
          <p className="mj-secondary sales-top-gap">Next step: {requestNext(request, !!paid)}</p>
        </Tile>

        {request.state === 'cancellation_requested' && <InlineNotification kind="warning" lowContrast hideCloseButton title="Waiting for the cancellation in wiRef" subtitle="Cash and card stay switched off for the order. Once wiRef cancelled or corrected the invoice, confirm it with the reference." />}
        {request.state === 'cancelled' && (
          successor
            ? <LinkNotification title="This request is cancelled" subtitle={`${successor.reference} replaced it.`} label={`Open ${successor.reference}`} to={`/sales/invoicing/${successor.id}`} />
            : <InlineNotification kind="info" lowContrast hideCloseButton title="This request is cancelled" subtitle={newBlocker === null ? 'The order is free again. Prepare a new request, or take a cash or card payment.' : `The order cannot get a new request right now: ${newBlocker.toLowerCase()}.`} />
        )}
        {request.state === 'issued' && !paid && order && <InlineNotification kind="info" lowContrast hideCloseButton title="Invoice issued, payment not yet confirmed" subtitle={`${formatEur(order.outstanding)} is outstanding. Record the payment here once wiRef confirms it.`} />}
        {request.state === 'issued' && paid && <InlineNotification kind="success" lowContrast hideCloseButton title="Payment confirmed" subtitle={`${order?.reference} is paid in full through wiRef.`} />}
        {!canManage && <InlineNotification kind="info" lowContrast hideCloseButton title="Read-only" subtitle="Changing a request needs the permission to manage wiRef requests." />}

        <div className="mj-detail-layout">
          <div className="mj-stack">
            <Tile>
              <h2 className="mj-section-title">Recipient and service</h2>
              {draft && canManage
                ? <RecipientDetailsForm request={request} organization={!!organization} requiresPurchaseOrder={!!customer?.requiresPurchaseOrder} onChange={(details, dirty) => setLive({ details, dirty })} />
                : (
                  <>
                    <Frozen details={request.details} />
                    {request.state !== 'draft' && request.state !== 'cancelled' && <p className="mj-secondary sales-top-gap">These details are frozen. To change them, cancel the request and prepare a new one.</p>}
                  </>
                )}
            </Tile>
            <ContainedList label="History" kind="on-page" className="sales-timeline">
              {history.map((event) => (
                <ContainedListItem key={event.id} renderIcon={Receipt}>
                  <span className="mj-cell-stack">
                    <strong>{requestEventLabel[event.kind]}</strong>
                    <span>{event.text}</span>
                    {(event.reconciliationKind || event.externalReference || event.effectiveOn) && (
                      <span className="mj-secondary">
                        {[event.reconciliationKind && reconciliationLabels[event.reconciliationKind].label, event.externalReference && `Reference ${event.externalReference}`, event.effectiveOn && `effective ${formatDate(`${event.effectiveOn}T12:00:00Z`)}`].filter(Boolean).join(' · ')}
                      </span>
                    )}
                    <span className="mj-secondary">{event.actor} · {formatDateTime(event.at)}</span>
                  </span>
                </ContainedListItem>
              ))}
            </ContainedList>
          </div>

          <div className="mj-stack">
            {(draft || request.state === 'ready') && (
              <Tile>
                <h2 className="mj-section-title">Ready to submit?</h2>
                <ul className="sales-checklist">
                  {checklist.map((item) => (
                    <li key={item.key}>
                      {item.ok ? <CheckmarkFilled className="sales-checklist__ok" /> : <Misuse className="sales-checklist__bad" />}
                      <span className="mj-cell-stack"><span>{item.label}</span>{!item.ok && <span className="mj-secondary">{item.hint}{item.key === 'po' && customer && <> · <CarbonLink as={Link} to={`/sales/customers/${customer.kind}/${customer.id}`}>Requirement set in Customers</CarbonLink></>}</span>}</span>
                    </li>
                  ))}
                </ul>
                {draft && live.dirty && <p className="mj-secondary sales-top-gap">Save the details to continue.</p>}
              </Tile>
            )}
            <Tile>
              <h2 className="mj-section-title">Details</h2>
              <dl className="mj-facts sales-facts">
                <div><dt>Order</dt><dd>{order ? <span className="mj-inline"><CarbonLink as={Link} to={`/sales/orders/${order.id}`}>{order.reference}</CarbonLink><OrderStatusTag order={order} /></span> : request.orderReference}</dd></div>
                <div><dt>Customer</dt><dd>{order?.customer ? <CarbonLink as={Link} to={`/sales/customers/${order.customer.kind}/${order.customer.id}`}>{order.customerLabel}</CarbonLink> : '—'}</dd></div>
                <div><dt>Requested amount</dt><dd>{formatEur(request.requestedAmount)}{order && order.net !== request.requestedAmount && <> <Tag type="red" size="sm">Order is now {formatEur(order.net)}</Tag></>}</dd></div>
                {issuedEvent?.externalReference && <div><dt>Invoice number</dt><dd>{issuedEvent.externalReference}{issuedEvent.effectiveOn && <span className="mj-secondary"> · {formatDate(`${issuedEvent.effectiveOn}T12:00:00Z`)}</span>}</dd></div>}
                <div><dt>Prepared</dt><dd>{formatDateTime(request.createdAt)}</dd></div>
                {predecessor && <div><dt>Replaces</dt><dd><CarbonLink as={Link} to={`/sales/invoicing/${predecessor.id}`}>{predecessor.reference}</CarbonLink></dd></div>}
                {successor && <div><dt>Replaced by</dt><dd><CarbonLink as={Link} to={`/sales/invoicing/${successor.id}`}>{successor.reference}</CarbonLink></dd></div>}
              </dl>
            </Tile>
          </div>
        </div>
      </div>
      {dialog && dialog !== 'pay' && <RequestDialog kind={dialog} request={request} order={order} onClose={() => setDialog(null)} />}
      {dialog === 'pay' && order && <RecordPaymentModal order={order} mode="record" onClose={() => setDialog(null)} />}
    </PageShell>
  );
}

export function InvoiceRequestPage() {
  const { requestId = '' } = useParams();
  const { query, data, views } = useSalesData();
  const request = data.requests.find((item) => item.id === requestId);
  return (
    <RequirePermission permission="external_invoice_requests.read" title="wiRef request" crumbs={crumbs}>
      {query.status === 'success' && request ? <RequestDetail request={request} order={views.find((item) => item.id === request.orderId) ?? null} /> : (
        <PageShell title={query.status === 'success' ? 'Request not found' : 'wiRef request'} breadcrumbs={crumbs} width="wide">
          <QueryBoundary query={query} errorMessage="The request could not be loaded.">
            <EmptyState title="This request does not exist" description="The link may be incorrect." action={<Button kind="tertiary" as={Link} to="/sales/invoicing">Back to invoicing</Button>} />
          </QueryBoundary>
        </PageShell>
      )}
    </RequirePermission>
  );
}
