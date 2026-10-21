import { Button, InlineNotification, Stack } from '@carbon/react';
import { Link } from 'react-router-dom';
import { resendExternalInvoiceRequestToWiRef } from '../../api/generated/external-invoicing/external-invoicing';
import type { ExternalInvoiceRequest } from '../../api/generated/models';
import { formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { useNotify } from '../machinelogbook/shared/toasts';
import { useFinanceMutation } from './queries';

const failureText: Record<string, string> = {
  mail_disabled: 'Email delivery is switched off.',
  send_failed: 'The mail server did not accept the message.',
  render_failed: 'The PDF could not be created.',
  settings_unavailable: 'The delivery settings could not be read.',
};

/**
 * Shows whether the approved request reached wiRef by mail and lets an approver send it again.
 * Rendered for issued requests only.
 */
export function WiRefDeliveryStatus({ request }: { request: ExternalInvoiceRequest }) {
  const user = useCurrentUser();
  const notify = useNotify();
  const canApprove = hasPermission(user, PermissionId.external_invoice_requestsapprove);
  const canConfigure = hasPermission(user, PermissionId.invoicingsettingsmanage);
  const resend = useFinanceMutation(
    () => resendExternalInvoiceRequestToWiRef(request.id),
    (updated) => {
      const status = updated.wirefDelivery?.status;
      notify(
        status === 'sent'
          ? { kind: 'success', title: 'Sent to wiRef' }
          : { kind: 'warning', title: 'Not sent to wiRef', subtitle: 'See the delivery status of the request.' },
      );
    },
  );
  const delivery = request.wirefDelivery;
  if (request.state !== 'issued' || !delivery) return null;
  const when = formatDateTime(delivery.attemptedAt);
  let kind: 'success' | 'error' | 'warning' = 'warning';
  let title = 'Not sent to wiRef';
  let subtitle = `Sending to wiRef was not set up when this request was forwarded. Copy the data manually${
    canConfigure
      ? ' or set up the wiRef delivery, then resend it.'
      : ', or ask an administrator to set up the wiRef delivery.'
  }`;
  if (delivery.status === 'sent') {
    kind = 'success';
    title = 'Sent to wiRef';
    subtitle = `The invoice information was mailed with a PDF on ${when}.`;
  } else if (delivery.status === 'failed') {
    kind = 'error';
    title = 'Not delivered to wiRef';
    subtitle = `${failureText[delivery.failureCode] ?? 'Sending failed.'} Last attempt ${when}. Copy the data manually or resend it.`;
  }
  return (
    <Stack gap={3}>
      <InlineNotification kind={kind} lowContrast hideCloseButton title={title} subtitle={subtitle} />
      {resend.error && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Resend failed"
          subtitle={resend.error.message}
        />
      )}
      {(canApprove || (delivery.status === 'not_configured' && canConfigure)) && (
        <div className="mj-inline">
          {canApprove && (
            <Button kind="tertiary" size="sm" disabled={resend.isPending} onClick={() => resend.mutate()}>
              {resend.isPending ? 'Sending…' : 'Resend to wiRef'}
            </Button>
          )}
          {delivery.status === 'not_configured' && canConfigure && (
            <Link to="/settings/invoicing">Set up the wiRef delivery</Link>
          )}
        </div>
      )}
    </Stack>
  );
}
