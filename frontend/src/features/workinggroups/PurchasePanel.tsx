import { useRef, useState } from 'react';
import { Download } from '@carbon/icons-react';
import { Button, InlineNotification, Link, OverflowMenu, OverflowMenuItem, Tag } from '@carbon/react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import type { WorkingGroupPurchase } from '../../api/generated/models';
import {
  approveWorkingGroupPurchase,
  arrivedWorkingGroupPurchase,
  convertWorkingGroupPurchaseToProject,
  deleteWorkingGroupPurchase,
  downloadWorkingGroupPurchaseAttachment,
  downloadWorkingGroupPurchaseReceipt,
  getDownloadWorkingGroupPurchaseAttachmentUrl,
  getDownloadWorkingGroupPurchaseReceiptUrl,
  refundedWorkingGroupPurchase,
  uploadWorkingGroupPurchaseAttachment,
} from '../../api/generated/working-groups/working-groups';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { DetailPanel, DetailPanelSection } from '../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../app/components/Facts';
import { formatDate } from '../../app/dateTime';
import { formatMoney } from '../orders/formatting';
import { formatCents } from '../orders/money';
import { RedactPurchaseDialog } from './FinanceExtraDialogs';
import { DeclineDialog, FilePreview, ReceiptDialog } from './PurchaseDialogs';
import {
  ACCEPTED_FILES,
  COUNTS_LABEL,
  PURCHASE_STATUS_LABEL,
  PURCHASE_STATUS_TAG,
  amountCents,
  fileHeaders,
  fileProblem,
  countsAs,
} from './financeModel';
import { LinkedTasks } from './LinkParts';
import { PanelHead } from './PanelHead';
import { PurchaseTrack } from './PurchaseList';
import { personName } from './taskModel';
import { useDialogOpener } from './useDialogOpener';
import { saveErrorText, taskErrorText, useWgMutation } from './useWgMutation';

function sentence(purchase: WorkingGroupPurchase): string {
  switch (purchase.status) {
    case 'wanted':
      return purchase.needsProject ? 'Needs a project first.' : 'Waiting for management to decide.';
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
    case 'planned':
      return 'Planned in a project. It is bought once the project runs.';
    case 'declined':
      return purchase.declineReason ? `Declined: ${purchase.declineReason}` : 'Declined.';
  }
}

/** The detail panel of a purchase: head, one sentence, one action row, facts, receipt. Keyed by the purchase. */
export function PurchasePanel({
  purchase,
  me,
  isLead,
  finance,
  onGone,
  onClose,
  inline = false,
}: {
  purchase: WorkingGroupPurchase;
  me: string;
  isLead: boolean;
  finance: boolean;
  onGone: () => void;
  onClose?: () => void;
  /** Compact detail row under the purchase's own row: no head, one meta line, facts and actions on one band. */
  inline?: boolean;
}) {
  const navigate = useNavigate();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const deleteButton = useRef<HTMLElement | null>(null);
  const menu = useRef<HTMLDivElement>(null);
  const hasMore = purchase.canDelete || finance;
  const decline = useDialogOpener();
  const receipt = useDialogOpener();
  const preview = useDialogOpener();
  const offer = useDialogOpener();
  const redact = useDialogOpener();
  const fileInput = useRef<HTMLInputElement>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const canAttach = purchase.status === 'wanted' && (purchase.requester?.personId === me || isLead);
  const attach = useWgMutation((file: File) =>
    uploadWorkingGroupPurchaseAttachment(purchase.id, file, { headers: fileHeaders(file) }),
  );
  const approve = useWgMutation(() => approveWorkingGroupPurchase(purchase.id, { expectedVersion: purchase.version }));
  const arrived = useWgMutation(() => arrivedWorkingGroupPurchase(purchase.id, { expectedVersion: purchase.version }));
  const refunded = useWgMutation(() =>
    refundedWorkingGroupPurchase(purchase.id, { expectedVersion: purchase.version }),
  );
  const remove = useWgMutation(() => deleteWorkingGroupPurchase(purchase.id));
  const toProject = useWgMutation(() =>
    convertWorkingGroupPurchaseToProject(purchase.id, { expectedVersion: purchase.version }),
  );
  const canTurn =
    purchase.needsProject &&
    purchase.status === 'wanted' &&
    !purchase.projectId &&
    (isLead || purchase.requester?.personId === me);
  const error =
    fileError ?? saveErrorText(toProject.error ?? approve.error ?? arrived.error ?? refunded.error ?? attach.error);
  const counts = countsAs(purchase);
  const busy = approve.isPending || arrived.isPending || refunded.isPending;

  const moreMenu = hasMore && (
    <OverflowMenu
      ref={menu}
      aria-label="More actions"
      iconDescription="More actions"
      flipped
      size={inline ? 'sm' : 'md'}
    >
      {finance && <OverflowMenuItem itemText="Remove personal data…" onClick={() => redact.open(true)} />}
      {purchase.canDelete && (
        <OverflowMenuItem
          itemText="Delete"
          isDelete
          hasDivider={finance}
          onClick={() => {
            deleteButton.current = menu.current?.querySelector('button') ?? null;
            remove.reset();
            setConfirmDelete(true);
          }}
        />
      )}
    </OverflowMenu>
  );
  const size = inline ? 'sm' : 'md';

  const head = (
    <PanelHead
      label={`Purchase · ${purchase.groupName}`}
      title={purchase.item}
      meta={[
        `${purchase.quantity} × ${formatMoney(purchase.unitPrice)}`,
        personName(purchase.requester),
        formatDate(purchase.createdAt),
      ]}
      tags={
        <>
          <Tag size="sm" type={PURCHASE_STATUS_TAG[purchase.status]}>
            {PURCHASE_STATUS_LABEL[purchase.status]}
          </Tag>
          {purchase.needsProject && (
            <Tag size="sm" type="red">
              Needs a project
            </Tag>
          )}
        </>
      }
      actions={moreMenu}
      onClose={onClose}
    />
  );
  const actionButtons = (
    <>
      {canTurn && (
        <Button
          kind="primary"
          size={size}
          disabled={toProject.isPending}
          onClick={() =>
            toProject.mutate(undefined, {
              onSuccess: (created) => void navigate(`/working-groups/projects/${(created as { id: string }).id}`),
            })
          }
        >
          Turn into a project
        </Button>
      )}
      {canAttach && (
        <>
          <input
            ref={fileInput}
            type="file"
            className="wg-visually-hidden"
            tabIndex={-1}
            accept={ACCEPTED_FILES}
            aria-label="Offer or cart file"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              const problem = fileProblem(file);
              setFileError(problem);
              if (!problem) attach.mutate(file);
            }}
          />
          <Button kind="tertiary" size={size} disabled={attach.isPending} onClick={() => fileInput.current?.click()}>
            {purchase.hasAttachment ? 'Replace the file' : 'Attach a file'}
          </Button>
        </>
      )}
      {purchase.canDecline && (
        <Button kind="tertiary" size={size} onClick={() => decline.open(true)}>
          Decline
        </Button>
      )}
      {purchase.canApprove && !purchase.needsProject && (
        <Button kind="primary" size={size} disabled={busy} onClick={() => approve.mutate()}>
          Approve
        </Button>
      )}
      {purchase.canHandInReceipt && (
        <Button kind="primary" size={size} onClick={() => receipt.open(true)}>
          Hand in the receipt
        </Button>
      )}
      {purchase.canMarkArrived && (
        <Button kind="primary" size={size} disabled={busy} onClick={() => arrived.mutate()}>
          It arrived
        </Button>
      )}
      {purchase.canMarkRefunded && (
        <Button kind="primary" size={size} disabled={busy} onClick={() => refunded.mutate()}>
          Money returned
        </Button>
      )}
    </>
  );
  const facts = (
    <FactsGrid columns={inline ? 4 : 2}>
      <Fact label="Amount" helper={COUNTS_LABEL[counts]}>
        {formatCents(amountCents(purchase))}
      </Fact>
      <Fact label="Stage">
        <PurchaseTrack purchase={purchase} />
      </Fact>
      <Fact label="Who buys" helper={purchase.how === 'self' ? 'Gets the money back' : 'Collective order'}>
        {purchase.how === 'self' ? personName(purchase.requester) : 'Management'}
      </Fact>
      {!(inline && purchase.projectId) && (
        <Fact label="Paid from" helper={purchase.projectId ? 'Project' : purchase.periodName}>
          {purchase.projectId ? (
            <Link as={RouterLink} to={`/working-groups/projects/${purchase.projectId}`}>
              Its project
            </Link>
          ) : (
            'Group budget'
          )}
        </Fact>
      )}
      {purchase.link && /^https?:\/\//i.test(purchase.link) && (
        <Fact label="Shop">
          <Link href={purchase.link} target="_blank" rel="noopener noreferrer">
            {safeHost(purchase.link)}
          </Link>
        </Fact>
      )}
      {purchase.hasAttachment && (
        <Fact label="Offer or cart">
          <div className="wg-receipt">
            <Link
              href="#"
              onClick={(event) => {
                event.preventDefault();
                offer.open(true);
              }}
            >
              Show the file
            </Link>
            <Link
              href={getDownloadWorkingGroupPurchaseAttachmentUrl(purchase.id)}
              download
              aria-label="Download offer or cart"
            >
              <Download size={16} />
            </Link>
          </div>
        </Fact>
      )}
    </FactsGrid>
  );
  return (
    <DetailPanel className={inline ? 'wg-inline' : 'wg-panel'}>
      {inline ? null : head}
      {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={error} />}

      {inline ? (
        <>
          <p className="wg-inline__meta">
            {[sentence(purchase), personName(purchase.requester), formatDate(purchase.createdAt)].join(' · ')}
          </p>
          <div className="wg-inline__band">
            {facts}
            <div className="wg-inline__actions">
              {actionButtons}
              {moreMenu}
            </div>
          </div>
        </>
      ) : (
        <>
          <p className="wg-panel__note">{sentence(purchase)}</p>
          <div className="wg-panel__actions">{actionButtons}</div>
          {facts}
        </>
      )}

      <LinkedTasks section groupId={purchase.groupId} tasks={purchase.linkedTasks} />

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
        error={remove.isError ? taskErrorText(remove.error, 'It could not be deleted.') : undefined}
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
      {preview.value && (
        <FilePreview
          title="Receipt"
          cacheKey={`receipt-${purchase.id}`}
          load={(signal) => downloadWorkingGroupPurchaseReceipt(purchase.id, { signal })}
          downloadUrl={getDownloadWorkingGroupPurchaseReceiptUrl(purchase.id)}
          onClose={preview.close}
        />
      )}
      {offer.value && (
        <FilePreview
          title="Offer or cart"
          cacheKey={`offer-${purchase.id}`}
          load={(signal) => downloadWorkingGroupPurchaseAttachment(purchase.id, { signal })}
          downloadUrl={getDownloadWorkingGroupPurchaseAttachmentUrl(purchase.id)}
          onClose={offer.close}
        />
      )}
      {redact.value && <RedactPurchaseDialog purchase={purchase} onClose={redact.close} />}
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
