import { useRef, useState } from 'react';
import { Button, InlineNotification, Link, Tag } from '@carbon/react';
import { ArrowRight, Checkmark, Download, TrashCan } from '@carbon/icons-react';
import { useNavigate } from 'react-router-dom';
import type { WorkingGroupProject, WorkingGroupProjectItem, WorkingGroupPurchase } from '../../api/generated/models';
import {
  deleteWorkingGroupProjectItem,
  deleteWorkingGroupProjectOffer,
  downloadWorkingGroupProjectOfferFile,
  getDownloadWorkingGroupProjectOfferFileUrl,
} from '../../api/generated/working-groups/working-groups';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { DetailPanel, DetailPanelHead, DetailPanelSection } from '../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../app/components/Facts';
import { formatDate } from '../../app/dateTime';
import { formatMoney } from '../orders/formatting';
import { formatCents, toCents } from '../orders/money';
import { amountCents, PURCHASE_STATUS_LABEL } from './financeModel';
import { ItemDialog, OfferDialog } from './ProjectDialogs';
import {
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_TAG,
  PROJECT_STEPS,
  dateRange,
  itemStatus,
  lastReason,
  paidFromLabel,
  projectStage,
  who,
} from './projectModel';
import { FilePreview } from './PurchaseDialogs';
import { formatDateOnly } from './taskModel';
import { PanelHead, PanelSection } from './PanelHead';
import { useDialogOpener } from './useDialogOpener';
import { taskErrorText, useWgMutation } from './useWgMutation';

const STEP_HINT = ['The group writes it', 'Management decides', 'WiRef decides', 'Buy and build', 'Report handed in'];

/** Dots on a line: Draft · Approval · WiRef · Running · Completed. */
export function ProjectStepper({ project }: { project: WorkingGroupProject }) {
  const stage = projectStage(project);
  return (
    <ol className="wg-hsteps" aria-label="Stage">
      {PROJECT_STEPS.map((step, index) => (
        <li
          key={step}
          className={
            index < stage.index
              ? 'is-past'
              : index === stage.index
                ? `is-now${stage.declined ? ' is-declined' : ''}`
                : ''
          }
          aria-current={index === stage.index ? 'step' : undefined}
        >
          <span className="wg-hsteps__dot" aria-hidden="true">
            {index < stage.index && <Checkmark size={12} />}
          </span>
          <span className="wg-hsteps__label">{index === stage.index ? stage.label : step}</span>
          <small>{STEP_HINT[index]}</small>
        </li>
      ))}
    </ol>
  );
}

/** Why a project was returned or declined, with author and date. */
export function ReasonBlock({ project }: { project: WorkingGroupProject }) {
  const reason = lastReason(project);
  if (!reason) return null;
  return (
    <blockquote className="wg-reason">
      <strong>{reason.title}</strong>
      <p>{reason.reason}</p>
      <small>
        {reason.actor?.displayName ?? 'Former member'} · {formatDate(reason.at)}
      </small>
    </blockquote>
  );
}

const SENTENCE: Record<WorkingGroupProject['status'], string> = {
  draft: 'Hand it in once the checklist is complete.',
  submitted: 'Waiting for management to decide.',
  returned: 'Management asked for changes.',
  declined: 'This project was declined.',
  wiref: 'Sent to the WiRef.',
  running: 'Approved. Purchases can be made.',
  completed: 'The project is completed.',
};

/** The panel of a project in the Projects list. */
export function ProjectPanel({
  project,
  purchases,
  onSelectPurchase,
  onClose,
}: {
  project: WorkingGroupProject;
  purchases: readonly WorkingGroupPurchase[];
  onSelectPurchase: (id: string) => void;
  onClose?: () => void;
}) {
  const navigate = useNavigate();
  const stage = projectStage(project);
  const counts =
    project.paidFrom === 'external'
      ? 'From an external source'
      : project.status === 'completed'
        ? 'Counts as spent'
        : project.status === 'running'
          ? 'Reserved until it is paid'
          : 'Not counted yet';
  return (
    <DetailPanel className="wg-panel">
      <PanelHead
        label={`Project · ${project.groupName}`}
        title={project.title}
        meta={[who(project), dateRange(project, formatDateOnly)]}
        tags={
          <Tag size="sm" type={PROJECT_STATUS_TAG[project.status]}>
            {PROJECT_STATUS_LABEL[project.status]}
          </Tag>
        }
        onClose={onClose}
      />
      <ReasonBlock project={project} />
      <p className="wg-panel__note">{SENTENCE[project.status]}</p>
      <div className="wg-panel__actions">
        <Button
          kind="primary"
          size="md"
          renderIcon={ArrowRight}
          onClick={() => void navigate(`/working-groups/projects/${project.id}`)}
        >
          Open project
        </Button>
      </div>
      <FactsGrid columns={2}>
        <Fact label="Planned" helper={counts}>
          {formatMoney(project.totals.planned)}
        </Fact>
        <Fact label="Stage">
          <StageTrack steps={PROJECT_STEPS} index={stage.index} label={stage.label} declined={stage.declined} />
        </Fact>
        <Fact label="Paid from">{paidFromLabel(project)}</Fact>
        <Fact label="WiRef number">{project.wirefNumber || 'None yet'}</Fact>
        <Fact label="Bought so far" helper={`of ${formatMoney(project.totals.planned)}`}>
          {formatMoney(project.totals.spent)}
        </Fact>
      </FactsGrid>
      <PanelSection title="Purchases" count={purchases.length}>
        {purchases.length === 0 ? (
          <p className="wg-panel__note">None yet.</p>
        ) : (
          <ul className="wg-plist">
            {purchases.map((purchase) => (
              <li key={purchase.id}>
                <span className="wg-plist__main">
                  <Link
                    href="#"
                    onClick={(event) => {
                      event.preventDefault();
                      onSelectPurchase(purchase.id);
                    }}
                  >
                    {purchase.item}
                  </Link>
                  <small>{PURCHASE_STATUS_LABEL[purchase.status]}</small>
                </span>
                <span className="wg-plist__amount">{formatCents(amountCents(purchase))}</span>
              </li>
            ))}
          </ul>
        )}
      </PanelSection>
    </DetailPanel>
  );
}

/** A segmented stage bar with its label, as in the lists. */
export function StageTrack({
  steps,
  index,
  label,
  declined,
}: {
  steps: readonly string[];
  index: number;
  label: string;
  declined?: boolean;
}) {
  const done = !declined && index === steps.length - 1;
  return (
    <span
      className={`wg-track${declined ? ' is-declined' : ''}${done ? ' is-done' : ''}`}
      role="img"
      aria-label={`Stage: ${label}, step ${index + 1} of ${steps.length}`}
    >
      <span className={`wg-track__bar${steps.length === 5 ? ' wg-track__bar--5' : ''}`} aria-hidden="true">
        {steps.map((step, at) => (
          <i key={step} className={at < index ? 'is-past' : at === index ? 'is-now' : ''} />
        ))}
      </span>
      <span className="wg-track__l" aria-hidden="true">
        {label}
      </span>
    </span>
  );
}

const itemSentence = (item: WorkingGroupProjectItem, purchases: readonly WorkingGroupPurchase[]) => {
  const status = itemStatus(item, purchases).label;
  if (item.needsOffers && !item.chosenOfferId && purchases.length === 0) {
    return `Three offers are needed. ${item.offers.length} of 3 added.`;
  }
  return `${status}.`;
};

/** The panel of a selected cost plan item on the project page. */
export function ProjectItemPanel({
  project,
  item,
  purchases,
  canPlan,
  canBuy,
  onBuy,
  onGone,
}: {
  project: WorkingGroupProject;
  item: WorkingGroupProjectItem;
  purchases: readonly WorkingGroupPurchase[];
  /** May add, edit and remove items and offers. */
  canPlan: boolean;
  canBuy: boolean;
  onBuy: (item: WorkingGroupProjectItem) => void;
  onGone: () => void;
}) {
  const edit = useDialogOpener();
  const offerDialog = useDialogOpener();
  const fileOpen = useDialogOpener<string>();
  const [confirm, setConfirm] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const [offerGone, setOfferGone] = useState<WorkingGroupProjectItem['offers'][number] | null>(null);
  const offerLauncher = useRef<HTMLElement | null>(null);
  const removeOffer = useWgMutation((offerId: string) => deleteWorkingGroupProjectOffer(project.id, offerId));
  const remove = useWgMutation(() => deleteWorkingGroupProjectItem(project.id, item.id));
  const status = itemStatus(item, purchases);
  const inPurchases = purchases
    .filter((purchase) => purchase.status !== 'declined')
    .reduce((sum, purchase) => sum + amountCents(purchase), 0);
  const left = Math.max(0, toCents(item.plannedAmount) - inPurchases);
  const chosen = item.offers.find((offer) => offer.id === item.chosenOfferId);
  const host = (() => {
    try {
      return item.link ? new URL(item.link).host : '';
    } catch {
      return '';
    }
  })();
  const canOffer = canPlan && item.needsOffers;

  return (
    <DetailPanel>
      <DetailPanelHead
        title={item.text}
        meta="Cost plan item"
        helper={
          <Tag size="sm" type={status.tag}>
            {status.label}
          </Tag>
        }
      />
      <p className="wg-panel-body">{itemSentence(item, purchases)}</p>
      <div className="wg-panel-actions">
        {canPlan && (
          <Button
            ref={removeButton}
            kind="danger--ghost"
            size="md"
            disabled={purchases.length > 0}
            onClick={() => {
              remove.reset();
              setConfirm(true);
            }}
          >
            Remove
          </Button>
        )}
        {canPlan && (
          <Button kind="tertiary" size="md" onClick={() => edit.open(true)}>
            Edit
          </Button>
        )}
        {canBuy && (
          <Button kind="primary" size="md" onClick={() => onBuy(item)}>
            {project.status === 'draft' || project.status === 'returned' ? 'Add the purchase' : 'Make a purchase'}
          </Button>
        )}
      </div>
      <FactsGrid columns={2}>
        <Fact label="Planned">{formatMoney(item.plannedAmount)}</Fact>
        <Fact label="In purchases">{formatCents(inPurchases)}</Fact>
        <Fact label="Left">{formatCents(left)}</Fact>
        {host && (
          <Fact label="Shop">
            <Link href={item.link} target="_blank" rel="noopener noreferrer">
              {host}
            </Link>
          </Fact>
        )}
      </FactsGrid>
      {(item.needsOffers || item.offers.length > 0) && (
        <DetailPanelSection title="Offers">
          <p className="wg-muted">{item.offers.length} of 3</p>
          <ul className="wg-plist">
            {item.offers.map((offer) => (
              <li key={offer.id}>
                <span>
                  {offer.shop} · {formatMoney(offer.price)}
                  {chosen?.id === offer.id && (
                    <Tag size="sm" type="green">
                      Chosen by the WiRef
                    </Tag>
                  )}
                </span>
                <span className="wg-receipt">
                  {offer.hasFile && (
                    <>
                      <Link
                        href="#"
                        onClick={(event) => {
                          event.preventDefault();
                          fileOpen.open(offer.id);
                        }}
                      >
                        Show the file
                      </Link>
                      <Link
                        href={getDownloadWorkingGroupProjectOfferFileUrl(project.id, offer.id)}
                        download
                        aria-label={`Download the file of ${offer.shop}`}
                      >
                        <Download size={16} />
                      </Link>
                    </>
                  )}
                  {canOffer && (
                    <Button
                      kind="ghost"
                      size="sm"
                      hasIconOnly
                      renderIcon={TrashCan}
                      iconDescription="Remove offer"
                      tooltipPosition="left"
                      onClick={() => {
                        removeOffer.reset();
                        setOfferGone(offer);
                      }}
                    />
                  )}
                </span>
              </li>
            ))}
          </ul>
          {canOffer && (
            <Button kind="tertiary" size="sm" onClick={() => offerDialog.open(true)}>
              Add an offer
            </Button>
          )}
        </DetailPanelSection>
      )}
      {item.note && (
        <DetailPanelSection title="Notes">
          <p>{item.note}</p>
        </DetailPanelSection>
      )}
      <DestructiveActionDialog
        open={confirm}
        title="Remove item"
        fate="permanent"
        confirmLabel="Remove item"
        pending={remove.isPending}
        error={remove.isError ? taskErrorText(remove.error, 'It could not be removed.') : undefined}
        launcherButtonRef={removeButton}
        onClose={() => setConfirm(false)}
        onConfirm={() =>
          remove.mutate(undefined, {
            onSuccess: () => {
              setConfirm(false);
              onGone();
            },
          })
        }
      >
        <p>{item.text}</p>
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={offerGone !== null}
        title="Remove offer"
        fate="permanent"
        confirmLabel="Remove offer"
        pending={removeOffer.isPending}
        error={removeOffer.isError ? taskErrorText(removeOffer.error, 'It could not be removed.') : undefined}
        launcherButtonRef={offerLauncher}
        onClose={() => setOfferGone(null)}
        onConfirm={() => offerGone && removeOffer.mutate(offerGone.id, { onSuccess: () => setOfferGone(null) })}
      >
        <p>{offerGone ? `${offerGone.shop} · ${formatMoney(offerGone.price)}` : ''}</p>
      </DestructiveActionDialog>
      {edit.value && <ItemDialog project={project} item={item} onClose={edit.close} />}
      {offerDialog.value && <OfferDialog project={project} item={item} onClose={offerDialog.close} />}
      {fileOpen.value && (
        <FilePreview
          title="Offer"
          cacheKey={`offer-${fileOpen.value}`}
          load={(signal) => downloadWorkingGroupProjectOfferFile(project.id, fileOpen.value as string, { signal })}
          downloadUrl={getDownloadWorkingGroupProjectOfferFileUrl(project.id, fileOpen.value)}
          onClose={fileOpen.close}
        />
      )}
    </DetailPanel>
  );
}

export function PurchaseStatusText({ purchase }: { purchase: WorkingGroupPurchase }) {
  return <>{PURCHASE_STATUS_LABEL[purchase.status]}</>;
}

export const NoteBanner = ({ text }: { text: string }) => (
  <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={text} />
);
