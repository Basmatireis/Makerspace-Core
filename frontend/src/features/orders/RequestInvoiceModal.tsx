import { useMemo } from 'react';
import { useForm } from 'react-hook-form';
import { InlineNotification, Modal, Stack, Tile } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { createExternalInvoiceRequest } from '../../api/generated/external-invoicing/external-invoicing';
import type { Order } from '../../api/generated/models';
import { dateInAppTimeZone } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { useNotify } from '../machinelogbook/shared/toasts';
import { organizationQuery, organizationRequirementsQuery } from '../organizations/queries';
import { activeItems, requestReadiness } from './logic';
import { formatCents, toCents } from './money';
import { useOperationKeys } from './operations';
import { useFinanceMutation } from './queries';
import { ReadinessChecklist } from './ReadinessChecklist';
import { RecipientFields } from './RecipientFields';
import { toRecipientValues, toRequestDetails, type RecipientValues } from './recipientValues';

/**
 * Asks wiRef for an invoice of the order. The recipient is prefilled from the customer. This works whether or not the customer already paid: cash and card
 * already received are carried on the request as "already paid", the rest is settled by the invoice once it is approved and forwarded to wiRef.
 */
export function RequestInvoiceModal({ order, onClose }: { order: Order; onClose: () => void }) {
  const user = useCurrentUser();
  const notify = useNotify();
  const key = useOperationKeys();
  const isOrganization = order.customerKind === 'organization';
  const organizationId = isOrganization ? order.customer?.id : undefined;
  const organization = useQuery({ ...organizationQuery(organizationId ?? ''), enabled: !!organizationId && hasPermission(user, PermissionId.organizationsread) });
  const requirements = useQuery({ ...organizationRequirementsQuery(organizationId ?? ''), enabled: !!organizationId });
  const requiresPurchaseOrder = !!requirements.data?.requirePurchaseOrderReference;

  const initial = useMemo<RecipientValues>(() => {
    const jobs = activeItems(order).flatMap((item) => (item.snapshot ? [item.snapshot] : []));
    const today = dateInAppTimeZone(new Date());
    const items = activeItems(order).length;
    const billing = organization.data;
    return toRecipientValues({
      recipientName: order.customerName ?? '', countryCode: billing?.countryCode || 'AT', addressLine1: billing?.addressLine ?? '', postalCode: billing?.postalCode ?? '', locality: billing?.locality ?? '', contactName: billing?.contactName ?? '',
      serviceStartsOn: jobs.length ? dateInAppTimeZone(jobs.map((job) => job.startsAt).sort()[0]) : today,
      serviceEndsOn: jobs.length ? dateInAppTimeZone(jobs.map((job) => job.endsAt).sort().at(-1)!) : today,
      serviceDescription: `Machine services and materials, ${items} ${items === 1 ? 'item' : 'items'}`,
    });
  }, [order, organization.data]);
  const form = useForm<RecipientValues>({ values: initial, resetOptions: { keepDirtyValues: true } });
  const values = form.watch();
  const checklist = requestReadiness(toRequestDetails(values), order.customerKind, requiresPurchaseOrder);
  const open = checklist.filter((item) => !item.ok);
  // Before the first invoice there is no external payment, so what the order has settled is cash and card.
  const alreadyPaid = Math.max(0, toCents(order.settledAmount));

  const mutation = useFinanceMutation(() => {
    const input = { expectedVersion: order.version, details: toRequestDetails(form.getValues()) };
    return createExternalInvoiceRequest(order.id, { ...input, operationKey: key('request', input) });
  }, (request) => {
    notify({ kind: 'success', title: 'Invoice requested', subtitle: `${request.reference} · ${formatCents(toCents(request.requestedAmount))}${toCents(request.alreadyPaid) > 0 ? `, ${formatCents(toCents(request.alreadyPaid))} already paid` : ''}. Complete the details, then submit it for approval.` });
    onClose();
  });
  const pending = mutation.isPending;

  return (
    <Modal open size="md" modalHeading="Request invoice" modalLabel={order.reference} primaryButtonText={pending ? 'Requesting…' : 'Request invoice'} secondaryButtonText="Cancel" primaryButtonDisabled={pending}
      preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => mutation.mutate()}>
      <Stack gap={5}>
        <p>Core hands the data over once it is approved; the invoice itself is issued by wiRef. Check the recipient, then request it.</p>
        <Tile>
          <h3 className="mj-section-title">Payment</h3>
          <dl className="mj-facts sales-facts">
            <div><dt>Invoice amount</dt><dd>{formatCents(toCents(order.totalAmount))}</dd></div>
            <div><dt>Already paid (cash or card)</dt><dd>{formatCents(alreadyPaid)}</dd></div>
            <div><dt>Still open</dt><dd>{formatCents(toCents(order.outstandingAmount))}</dd></div>
          </dl>
          <p className="mj-secondary sales-top-gap">
            {alreadyPaid > 0 ? 'What was paid is stated on the invoice request and the invoice is marked paid for it. ' : ''}
            {toCents(order.outstandingAmount) > 0 ? 'The order stays open until the invoice is approved and forwarded to wiRef; then the invoice settles the rest and the order is paid.' : 'The order is paid in full, so the invoice is marked paid.'}
          </p>
        </Tile>
        <RecipientFields form={form} idPrefix="request-invoice" organization={isOrganization} requiresPurchaseOrder={requiresPurchaseOrder} disabled={pending} />
        <div>
          <ReadinessChecklist label="Ready to submit?" items={checklist} />
          {open.length > 0 && <p className="mj-secondary sales-top-gap">You can request the invoice now and complete {open.length === 1 ? 'this' : 'these'} later; it cannot be submitted for approval before.</p>}
        </div>
        {mutation.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Could not request the invoice" subtitle={mutation.error.message} />}
      </Stack>
    </Modal>
  );
}
