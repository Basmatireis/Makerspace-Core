import { useState } from 'react';
import {
  Accordion, AccordionItem, Button, ContainedList, ContainedListItem, InlineNotification, OverflowMenu, OverflowMenuItem, ProgressIndicator, ProgressStep, Tile,
} from '@carbon/react';
import { CheckmarkFilled, Copy, Misuse, Receipt } from '@carbon/icons-react';
import { formatDate, formatDateTime, formatEur, round2 } from '../format';
import { reconciliationLabels, requestEventLabel, requestStateLabel } from '../labels';
import { INVOICE_STEPS, invoiceNumberOf, latestReturn, requestNext, requestProgress, requestReadiness, type OrderView } from '../logic';
import { RequestDialog, type RequestDialogKind } from '../dialogs/RequestDialogs';
import { RequestInvoiceModal } from '../dialogs/RequestInvoiceModal';
import { invoiceRequestBlocker } from '../engine';
import { ProposedTag, RequestStateTag } from '../status';
import { useMediaQuery } from '../useMediaQuery';
import { LinkifiedText, RichNotification } from '../../components/RefLink';
import { useStore } from '../../store';
import type { InvoiceRequest, InvoiceRequestDetails } from '../types';
import { RecipientDetailsForm } from './RecipientDetailsForm';

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

/** The invoice of an order, issued by wiRef: progress, the next step with every action of the state, recipient details, checklist and history. */
export function InvoiceSection({ order, request }: { order: OrderView; request: InvoiceRequest }) {
  const store = useStore();
  const narrow = useMediaQuery('(max-width: 41.98rem)');
  const [dialog, setDialog] = useState<RequestDialogKind | 'again' | null>(null);
  const [live, setLive] = useState<{ details: InvoiceRequestDetails; dirty: boolean }>({ details: request.details, dirty: false });
  const organization = store.organizations.find((item) => item.id === order.customer.id);
  const canManage = store.can('external_invoice_requests.manage');
  const canApprove = store.can('external_invoice_requests.approve');
  const draft = request.state === 'draft';
  const awaiting = request.state === 'submitted';
  // Staff edit the draft; while the request awaits approval only management edits it.
  const editable = (draft && canManage) || (awaiting && canApprove);
  const shownDetails = editable && live.dirty ? live.details : request.details;
  const checklist = requestReadiness({ details: shownDetails }, order.customer, organization);
  const complete = checklist.every((item) => item.ok);
  const paid = order.settlement === 'paid' || order.settlement === 'no_payment_due';
  const progress = requestProgress(request);
  const predecessor = store.requests.find((item) => item.id === request.supersedesRequestId);
  const invoiceNumber = invoiceNumberOf(request);
  const returned = latestReturn(request);
  const newBlocker = invoiceRequestBlocker(store, order);

  let primary: { label: string; disabled?: boolean; run: () => void } | null = null;
  let secondary: { label: string; run: () => void } | null = null;
  if (canManage) {
    if (draft) primary = { label: 'Submit for approval', disabled: !complete || live.dirty, run: () => setDialog('submit') };
    else if (request.state === 'cancellation_requested') primary = { label: 'Confirm cancellation', run: () => setDialog('confirm-cancellation') };
    else if (request.state === 'cancelled' && newBlocker === null) primary = { label: 'Request invoice again', run: () => setDialog('again') };
  }
  if (awaiting && canApprove) {
    primary = { label: 'Copy for wiRef', disabled: !complete || live.dirty, run: () => setDialog('forward') };
    secondary = { label: 'Return for correction', run: () => setDialog('return') };
  }
  const menu = [
    ((draft && canManage) || (awaiting && canApprove)) && <OverflowMenuItem key="cancel" itemText="Cancel request" isDelete onClick={() => setDialog('cancel')} />,
    canManage && request.state === 'issued' && <OverflowMenuItem key="request-cancellation" itemText="Request cancellation…" onClick={() => setDialog('request-cancellation')} />,
    canManage && (request.state === 'issued' || request.state === 'cancellation_requested') && <OverflowMenuItem key="reference" itemText={invoiceNumber ? 'Correct invoice number…' : 'Add wiRef invoice number…'} onClick={() => setDialog('reference')} />,
  ].filter(Boolean);
  const history = [...request.events].sort((a, b) => b.at.localeCompare(a.at));
  const toPay = request.state === 'cancelled' ? null : order.outstanding;

  return (
    <Tile id="invoice" className="sales-invoice">
      <div className="sales-invoice__head">
        <h2 className="mj-section-title mj-inline">Invoice <RequestStateTag request={request} size="md" /><ProposedTag hint="Approval by management before a request is forwarded to wiRef needs a new request state and the permission external_invoice_requests.approve" /></h2>
        <span className="mj-inline">
          {secondary && <Button kind="tertiary" size="md" onClick={secondary.run}>{secondary.label}</Button>}
          {primary && <Button kind="primary" size="md" renderIcon={primary.label === 'Copy for wiRef' ? Copy : undefined} disabled={primary.disabled} onClick={primary.run}>{primary.label}</Button>}
          {menu.length > 0 && <OverflowMenu aria-label="More invoice actions" iconDescription="More invoice actions" flipped>{menu}</OverflowMenu>}
        </span>
      </div>
      {returned && (
        <RichNotification kind="warning" title="Returned for correction" className="sales-invoice__returned">
          <LinkifiedText text={returned.reason ?? returned.text} />
          <br /><span className="mj-secondary">{returned.actor} · {formatDateTime(returned.at)}</span>
        </RichNotification>
      )}
      <ProgressIndicator currentIndex={progress.index} spaceEqually vertical={narrow} className="sales-progress">
        {INVOICE_STEPS.map((label, index) => (
          <ProgressStep key={label} label={label} invalid={progress.invalid && index === progress.index} secondaryLabel={progress.invalid && index === progress.index ? requestStateLabel[request.state] : undefined} />
        ))}
      </ProgressIndicator>
      <p className="mj-secondary sales-top-gap">{request.reference} · Next step: {requestNext(request, paid, complete)}</p>

      <dl className="mj-facts sales-facts sales-top-gap">
        <div><dt>Invoice amount</dt><dd>{formatEur(request.requestedAmount)}{order.net !== request.requestedAmount && ` (the order is now ${formatEur(order.net)})`}</dd></div>
        <div><dt>Already paid (cash or card)</dt><dd>{formatEur(request.alreadyPaid)}{request.state === 'draft' && request.alreadyPaid > 0 ? ' · follows payments until it is submitted' : ''}</dd></div>
        {toPay !== null && <div><dt>{request.state === 'issued' ? 'Settled by this invoice' : 'Open on the order'}</dt><dd>{request.state === 'issued' ? formatEur(round2(request.requestedAmount - request.alreadyPaid)) : formatEur(toPay)}</dd></div>}
        {invoiceNumber?.externalReference && <div><dt>wiRef invoice number</dt><dd>{invoiceNumber.externalReference}{invoiceNumber.effectiveOn && <span className="mj-secondary"> · {formatDate(`${invoiceNumber.effectiveOn}T12:00:00Z`)}</span>}</dd></div>}
        {!invoiceNumber && request.state === 'issued' && (
          <div><dt>wiRef invoice number</dt><dd>{canManage ? <Button kind="ghost" size="sm" onClick={() => setDialog('reference')}>Add wiRef invoice number</Button> : <span className="mj-secondary">Not recorded yet</span>}</dd></div>
        )}
        {predecessor && <div><dt>Replaces</dt><dd>{predecessor.reference}</dd></div>}
      </dl>

      <div className="mj-stack sales-top-gap">
        {request.state === 'cancellation_requested' && <InlineNotification kind="warning" lowContrast hideCloseButton title="Waiting for the cancellation in wiRef" subtitle="Cash and card stay switched off for the order. Once wiRef cancelled or corrected the invoice, confirm it with the reference." />}
        {request.state === 'cancelled' && <InlineNotification kind="info" lowContrast hideCloseButton title="This request is cancelled" subtitle={newBlocker === null ? 'The order is free again. Request the invoice again, or take a cash or card payment.' : `The order cannot get a new request right now: ${newBlocker.toLowerCase()}.`} />}
        {request.state === 'issued' && paid && <InlineNotification kind="success" lowContrast hideCloseButton title="Issued, the order is paid" subtitle={`${order.reference} counts as paid: the invoice settles the balance. The customer pays wiRef by bank transfer outside Core.`} />}
        {awaiting && !canApprove && <InlineNotification kind="info" lowContrast hideCloseButton title="Waiting for approval by management" subtitle="Management checks the data and forwards it to wiRef. Until then the request is read-only." />}
        {awaiting && canApprove && <InlineNotification kind="info" lowContrast hideCloseButton title="Approval needed" subtitle="Check the data and correct it here if needed. Then copy it to wiRef and mark the request as forwarded, or return it with a comment." />}
        {!canManage && !(awaiting && !canApprove) && <InlineNotification kind="info" lowContrast hideCloseButton title="Read-only" subtitle="Changing an invoice request needs the permission to manage wiRef requests." />}
        {(draft || (awaiting && canApprove)) && (
          <div>
            <p className="cds--label">{draft ? 'Ready to submit?' : 'Ready to forward?'}</p>
            <ul className="sales-checklist">
              {checklist.map((item) => (
                <li key={item.key}>
                  {item.ok ? <CheckmarkFilled className="sales-checklist__ok" /> : <Misuse className="sales-checklist__bad" />}
                  <span className="mj-cell-stack"><span>{item.label}</span>{!item.ok && <span className="mj-secondary">{item.hint}{item.key === 'po' && ' · set under Pricing > Organizations'}</span>}</span>
                </li>
              ))}
            </ul>
            {editable && live.dirty && <p className="mj-secondary sales-top-gap">Save the details to continue.</p>}
          </div>
        )}
        <Accordion size="md">
          <AccordionItem title="Recipient and service" open={editable}>
            {editable
              ? <RecipientDetailsForm key={`${request.state}-${request.version}`} request={request} editedByManagement={awaiting} organization={order.customer.kind === 'organization'} requiresPurchaseOrder={!!organization?.requiresPurchaseOrder} onChange={(details, dirty) => setLive({ details, dirty })} />
              : (
                <>
                  <Frozen details={request.details} />
                  {(request.state === 'issued' || request.state === 'cancellation_requested') && <p className="mj-secondary sales-top-gap">These details are frozen. To change them, cancel the request and request the invoice again.</p>}
                </>
              )}
          </AccordionItem>
          <AccordionItem title={`History (${history.length})`}>
            <ContainedList label="History" kind="disclosed" className="sales-timeline">
              {history.map((event) => (
                <ContainedListItem key={event.id} renderIcon={Receipt}>
                  <span className="mj-cell-stack">
                    <strong>{requestEventLabel[event.kind]}</strong>
                    <span><LinkifiedText text={event.text} /></span>
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
          </AccordionItem>
        </Accordion>
      </div>
      {dialog === 'again' && <RequestInvoiceModal order={order} onClose={() => setDialog(null)} />}
      {dialog && dialog !== 'again' && <RequestDialog kind={dialog} request={request} order={order} onClose={() => setDialog(null)} />}
    </Tile>
  );
}
