import { useRef, useState } from 'react';
import { Download } from '@carbon/icons-react';
import { Button, InlineNotification, Link, Tag } from '@carbon/react';
import type { WorkingGroupPurchase } from '../../api/generated/models';
import {
  approveWorkingGroupPurchase,
  arrivedWorkingGroupPurchase,
  deleteWorkingGroupPurchase,
  getDownloadWorkingGroupPurchaseAttachmentUrl,
  getDownloadWorkingGroupPurchaseReceiptUrl,
  refundedWorkingGroupPurchase,
} from '../../api/generated/working-groups/working-groups';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { DetailPanel, DetailPanelHead, DetailPanelSection } from '../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../app/components/Facts';
import { formatDate } from '../../app/dateTime';
import { formatMoney } from '../orders/formatting';
import { formatCents } from '../orders/money';
import { DeclineDialog, ReceiptDialog, ReceiptPreview } from './PurchaseDialogs';
import {
  COUNTS_LABEL,
  PURCHASE_STATUS_LABEL,
  PURCHASE_STATUS_TAG,
  amountCents,
  countsAs,
  stageOf,
} from './financeModel';
import { firstName, personName } from './taskModel';
import { useDialogOpener } from './useDialogOpener';
import { saveErrorText, useWgMutation } from './useWgMutation';

function sentence(purchase: WorkingGroupPurchase): string {
  switch (purchase.status) {
    case 'wanted':
      return purchase.needsProject
        ? 'This reaches the project limit and needs a project first.'
        : 'Waiting for management to decide.';
    case 'approved':
      return purchase.how === 'self'
        ? 'Approved. Buy it and hand in the receipt.'
        : 'Approved. It goes into the next collective order.';
    case 'ordered':
      return 'Ordered with a collective order.';
    case 'bought':
      return 'Bought. The money is still to be returned.';
    case 'received':
      return 'It arrived.';
    case 'refunded':
      return 'The money was returned.';
    default:
      return purchase.declineReason ? `Declined: ${purchase.declineReason}` : 'Declined.';
  }
}

/** The detail panel of a purchase: head, one sentence, one action row, facts, receipt. Keyed by the purchase. */
export function PurchasePanel({ purchase, onGone }: { purchase: WorkingGroupPurchase; onGone: () => void }) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const decline = useDialogOpener();
  const receipt = useDialogOpener();
  const preview = useDialogOpener();
  const approve = useWgMutation(() => approveWorkingGroupPurchase(purchase.id, { expectedVersion: purchase.version }));
  const arrived = useWgMutation(() => arrivedWorkingGroupPurchase(purchase.id, { expectedVersion: purchase.version }));
  const refunded = useWgMutation(() =>
    refundedWorkingGroupPurchase(purchase.id, { expectedVersion: purchase.version }),
  );
  const remove = useWgMutation(() => deleteWorkingGroupPurchase(purchase.id));
  const error = saveErrorText(approve.error ?? arrived.error ?? refunded.error);
  const stage = stageOf(purchase);
  const counts = countsAs(purchase);
  const busy = approve.isPending || arrived.isPending || refunded.isPending;

  return (
    <DetailPanel>
      <DetailPanelHead
        title={purchase.item}
        meta={`Purchase · ${purchase.groupName}`}
        secondary={`${purchase.quantity} × ${formatMoney(purchase.unitPrice)} · ${
          purchase.requester ? firstName(purchase.requester) : 'Former member'
        } · ${formatDate(purchase.createdAt)}`}
        helper={
          <>
            <Tag size="sm" type={PURCHASE_STATUS_TAG[purchase.status]}>
              {PURCHASE_STATUS_LABEL[purchase.status]}
            </Tag>
            {purchase.needsProject && (
              <Tag size="sm" type="magenta">
                Needs a project
              </Tag>
            )}
          </>
        }
      />
      {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error} />}
      <p className="wg-panel-body">{sentence(purchase)}</p>

      <div className="wg-panel-actions">
        {purchase.canDelete && (
          <Button
            ref={deleteButton}
            kind="danger--ghost"
            size="md"
            onClick={() => {
              remove.reset();
              setConfirmDelete(true);
            }}
          >
            Delete
          </Button>
        )}
        {purchase.canDecline && (
          <Button kind="tertiary" size="md" onClick={() => decline.open(true)}>
            Decline
          </Button>
        )}
        {purchase.canApprove && !purchase.needsProject && (
          <Button kind="primary" size="md" disabled={busy} onClick={() => approve.mutate()}>
            Approve
          </Button>
        )}
        {purchase.canHandInReceipt && (
          <Button kind="primary" size="md" onClick={() => receipt.open(true)}>
            Hand in the receipt
          </Button>
        )}
        {purchase.canMarkArrived && (
          <Button kind="primary" size="md" disabled={busy} onClick={() => arrived.mutate()}>
            It arrived
          </Button>
        )}
        {purchase.canMarkRefunded && (
          <Button kind="primary" size="md" disabled={busy} onClick={() => refunded.mutate()}>
            Money returned
          </Button>
        )}
      </div>

      <FactsGrid columns={2}>
        <Fact label="Amount" helper={COUNTS_LABEL[counts]}>
          {formatCents(amountCents(purchase))}
        </Fact>
        <Fact label="Stage">{stage.label}</Fact>
        <Fact label="Who buys">{purchase.how === 'self' ? personName(purchase.requester) : 'Management'}</Fact>
        <Fact label="Period">{purchase.periodName}</Fact>
        {purchase.link && /^https?:\/\//i.test(purchase.link) && (
          <Fact label="Shop">
            <Link href={purchase.link} target="_blank" rel="noopener noreferrer">
              {safeHost(purchase.link)}
            </Link>
          </Fact>
        )}
        {purchase.hasAttachment && (
          <Fact label="Offer or cart">
            <Link href={getDownloadWorkingGroupPurchaseAttachmentUrl(purchase.id)} target="_blank" rel="noopener">
              Open the file
            </Link>
          </Fact>
        )}
      </FactsGrid>

      {purchase.hasReceipt && (
        <DetailPanelSection title="Receipt">
          <div className="wg-receipt">
            <Link
              href="#"
              onClick={(event) => {
                event.preventDefault();
                preview.open(true);
              }}
            >
              Show the receipt
            </Link>
            <Link href={getDownloadWorkingGroupPurchaseReceiptUrl(purchase.id)} download aria-label="Download receipt">
              <Download size={16} />
            </Link>
          </div>
          <p className="wg-muted">
            {purchase.actualTotal ? `${formatMoney(purchase.actualTotal)} on the receipt` : ''}
            {purchase.actualTotal ? ' · ' : ''}
            {formatMoney(purchase.estimatedTotal)} estimated
          </p>
        </DetailPanelSection>
      )}

      <DestructiveActionDialog
        open={confirmDelete}
        title="Delete purchase"
        fate="permanent"
        confirmLabel="Delete purchase"
        pending={remove.isPending}
        error={remove.isError ? 'It could not be deleted.' : undefined}
        launcherButtonRef={deleteButton}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              setConfirmDelete(false);
              onGone();
            },
          })
        }
      >
        <p>{purchase.item}</p>
      </DestructiveActionDialog>
      {decline.value && <DeclineDialog purchase={purchase} onClose={decline.close} />}
      {receipt.value && <ReceiptDialog purchase={purchase} onClose={receipt.close} />}
      {preview.value && <ReceiptPreview purchaseId={purchase.id} onClose={preview.close} />}
    </DetailPanel>
  );
}

function safeHost(link: string): string {
  try {
    return new URL(link).host;
  } catch {
    return link;
  }
}
