import { useMemo, useState } from 'react';
import { Button, InlineNotification, Link as CarbonLink, Select, SelectItem, Tag } from '@carbon/react';
import { Checkmark, ErrorFilled } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type {
  WorkingGroupProject,
  WorkingGroupProjectItem,
  WorkingGroupProjectPaidFrom,
  WorkingGroupPurchase,
} from '../../api/generated/models';
import {
  downloadWorkingGroupProjectRequestPdf,
  getDownloadWorkingGroupProjectRequestPdfUrl,
  markWorkingGroupProjectAdvanceReceived,
  previewWorkingGroupProjectRequest,
  sendWorkingGroupProjectToWiRef,
  setWorkingGroupProjectPaidFrom,
  submitWorkingGroupProject,
} from '../../api/generated/working-groups/working-groups';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { formatDate } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { formatMoney } from '../orders/formatting';
import { formatCents, toCents } from '../orders/money';
import { ApproveDialog } from './ApproveDialog';
import { CompleteDialog, ItemDialog, ProjectDialog, ReasonDialog, WiRefDecisionDialog } from './ProjectDialogs';
import { ProjectItemPanel, ProjectStepper, ReasonBlock } from './ProjectParts';
import {
  PAID_FROM_LABEL,
  PROJECT_STATUS_LABEL,
  PROJECT_STATUS_TAG,
  checklistRows,
  dateRange,
  isEndState,
  itemCaption,
  itemStatus,
  paidFromLabel,
  requestAttachments,
  who,
} from './projectModel';
import { projectOptions } from './projectQueries';
import { AddPurchasesDialog, FilePreview, type PurchasePrefill } from './PurchaseDialogs';
import { PurchasePanel } from './PurchasePanel';
import { amountCents, PURCHASE_STATUS_LABEL } from './financeModel';
import { financeRulesOptions, purchasesOptions } from './financeQueries';
import { workingGroupsOptions } from './queries';
import { formatDateOnly } from './taskModel';
import { useDialogOpener } from './useDialogOpener';
import { saveErrorText, useWgMutation } from './useWgMutation';
import './workinggroups.scss';

const CRUMBS = [
  { label: 'Working groups', to: '/working-groups' },
  { label: 'Projects', to: '/working-groups/projects' },
];

const HISTORY_LABEL: Record<string, string> = {
  paid_from: 'Paid from changed',
  advance_received: 'Advance arrived',
  wiref_request_sent: 'Request sent to the WiRef',
};

export function ProjectPage() {
  const { projectId = '' } = useParams();
  const query = useQuery(projectOptions(projectId));
  if (query.isPending) {
    return (
      <PageShell title="Project" breadcrumbs={CRUMBS}>
        <InlineLoadingState label="Loading the project" />
      </PageShell>
    );
  }
  if (query.isError) {
    return (
      <PageShell title="Project" breadcrumbs={CRUMBS}>
        <ErrorState title="Project unavailable" message="It does not exist or you may not see it." />
      </PageShell>
    );
  }
  return <ProjectView project={query.data} />;
}

type Selection = { kind: 'item' | 'purchase'; id: string } | null;

function ProjectView({ project }: { project: WorkingGroupProject }) {
  const me = useCurrentUser();
  const finance = hasPermission(me, PermissionId.working_group_financesmanage);
  const groups = useQuery(workingGroupsOptions);
  const rules = useQuery(financeRulesOptions);
  const purchasesQuery = useQuery(purchasesOptions({ groupId: project.groupId }));
  const group = groups.data?.items.find((entry) => entry.id === project.groupId);
  const purchases = useMemo(
    () => (purchasesQuery.data?.items ?? []).filter((purchase) => purchase.projectId === project.id),
    [purchasesQuery.data, project.id],
  );
  const [selected, setSelected] = useState<Selection>(null);
  const edit = useDialogOpener();
  const addItem = useDialogOpener();
  const approve = useDialogOpener();
  const reason = useDialogOpener<'return' | 'decline' | 'wiref-decline'>();
  const wiref = useDialogOpener();
  const complete = useDialogOpener();
  const buy = useDialogOpener<PurchasePrefill | 'plain'>();
  const preview = useDialogOpener();
  const sentPdf = useDialogOpener();

  const draftLike = project.status === 'draft' || project.status === 'returned';
  const canPlan = project.canEdit || (finance && !isEndState(project));
  const canBuyItem = project.status === 'running' || (draftLike && project.canEdit);
  const submit = useWgMutation(() => submitWorkingGroupProject(project.id, { expectedVersion: project.version }));
  const sendWiRef = useWgMutation(() =>
    sendWorkingGroupProjectToWiRef(project.id, { expectedVersion: project.version }),
  );
  const advance = useWgMutation(() =>
    markWorkingGroupProjectAdvanceReceived(project.id, { expectedVersion: project.version }),
  );
  const paidFrom = useWgMutation((value: WorkingGroupProjectPaidFrom) =>
    setWorkingGroupProjectPaidFrom(project.id, { expectedVersion: project.version, paidFrom: value }),
  );
  const actionError = saveErrorText(submit.error ?? sendWiRef.error ?? advance.error ?? paidFrom.error);

  const rows = checklistRows(project);
  const checklist = project.checklist;
  const byItem = (itemId: string) => purchases.filter((purchase) => purchase.projectItemId === itemId);
  const loose = purchases.filter(
    (purchase) => !purchase.projectItemId || !project.items.some((i) => i.id === purchase.projectItemId),
  );
  const spent = toCents(project.totals.spent);
  const inPurchases = toCents(project.totals.inPurchases);
  const requested = Math.max(0, inPurchases - spent);
  const notBought = toCents(project.totals.left);
  const barTotal = Math.max(1, spent + requested + notBought);
  const selectedItem = selected?.kind === 'item' ? project.items.find((item) => item.id === selected.id) : undefined;
  const selectedPurchase = selected?.kind === 'purchase' ? purchases.find((p) => p.id === selected.id) : undefined;

  const makePurchase = (item: WorkingGroupProjectItem) => {
    const chosen = item.offers.find((offer) => offer.id === item.chosenOfferId);
    buy.open({
      projectId: project.id,
      projectItemId: item.id,
      item: item.text,
      link: item.link,
      priceCents: toCents(chosen?.price ?? item.plannedAmount),
      offerId: chosen?.hasFile ? chosen.id : undefined,
    });
  };

  const attachments = requestAttachments(project);
  const history = [...project.history].reverse();

  return (
    <PageShell title={project.title} width="wide" breadcrumbs={[...CRUMBS, { label: project.title, to: '#' }]}>
      <p>
        <Link to={`/working-groups/projects?group=${project.groupId}`}>Back to projects</Link>
      </p>
      {actionError && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={actionError} />
      )}

      <div className="wg-pj-top">
        <section className="wg-card wg-phead" aria-label="Project">
          <div className="wg-phead__row">
            <h2>{project.title}</h2>
            <Tag type={PROJECT_STATUS_TAG[project.status]}>{PROJECT_STATUS_LABEL[project.status]}</Tag>
          </div>
          <p className="wg-muted">
            {[who(project), dateRange(project, formatDateOnly), paidFromLabel(project), project.groupName]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <ProjectStepper project={project} />
        </section>

        <section className="wg-card" aria-label="What happens next">
          <h3>What happens next</h3>
          <ReasonBlock project={project} />
          {draftLike && (
            <>
              <ul className="wg-todo-list">
                {rows.map((row) => (
                  <li key={row.key} className={row.done ? 'is-done' : 'is-open'}>
                    {row.done ? <Checkmark size={16} aria-label="Done" /> : <ErrorFilled size={16} aria-label="Open" />}
                    {!row.done && row.itemId ? (
                      <CarbonLink
                        href="#"
                        onClick={(event) => {
                          event.preventDefault();
                          setSelected({ kind: 'item', id: row.itemId as string });
                        }}
                      >
                        {row.label}
                      </CarbonLink>
                    ) : (
                      <span>{row.label}</span>
                    )}
                  </li>
                ))}
              </ul>
              <div className="wg-panel-actions">
                {project.canEdit && (
                  <Button kind="tertiary" size="md" onClick={() => edit.open(true)}>
                    Edit
                  </Button>
                )}
                {project.canSubmit && (
                  <Button
                    kind="primary"
                    size="md"
                    disabled={!checklist.complete || submit.isPending}
                    onClick={() => submit.mutate(undefined)}
                  >
                    Hand in for approval
                  </Button>
                )}
              </div>
            </>
          )}
          {project.status === 'submitted' && (
            <>
              <p className="wg-muted">Waiting for management to decide.</p>
              {project.canDecide && (
                <div className="wg-panel-actions">
                  <Button kind="danger--tertiary" size="md" onClick={() => reason.open('decline')}>
                    Decline
                  </Button>
                  <Button kind="tertiary" size="md" onClick={() => reason.open('return')}>
                    Return with a comment
                  </Button>
                  <Button kind="primary" size="md" onClick={() => approve.open(true)}>
                    Approve
                  </Button>
                </div>
              )}
            </>
          )}
          {project.status === 'wiref' && (
            <>
              <p className="wg-muted">
                {project.wirefRequestPending ? 'The request is not sent to the WiRef yet.' : 'Waiting for the WiRef.'}
              </p>
              {project.canDecide && (
                <div className="wg-panel-actions">
                  <Button kind="danger--tertiary" size="md" onClick={() => reason.open('wiref-decline')}>
                    WiRef declined it
                  </Button>
                  <Button kind="primary" size="md" onClick={() => wiref.open(true)}>
                    WiRef approved it
                  </Button>
                </div>
              )}
            </>
          )}
          {project.status === 'running' && (
            <div className="wg-panel-actions">
              {finance && project.advanceStatus === 'asked' && (
                <Button
                  kind="tertiary"
                  size="md"
                  disabled={advance.isPending}
                  onClick={() => advance.mutate(undefined)}
                >
                  Advance arrived
                </Button>
              )}
              {project.canComplete && (
                <Button kind="primary" size="md" onClick={() => complete.open(true)}>
                  Complete the project
                </Button>
              )}
            </div>
          )}
          {project.status === 'completed' && <p>{project.completionReport || 'The project is completed.'}</p>}
          {project.status === 'declined' && <p className="wg-muted">This project was declined.</p>}
        </section>
      </div>

      <div className="wg-pj-body">
        <section className="wg-card" aria-label="Cost plan and purchases">
          <div className="wg-pj-cardhead">
            <h3>Cost plan and purchases</h3>
            <div className="wg-toolbar__actions">
              {canPlan && (
                <Button kind="tertiary" size="md" onClick={() => addItem.open(true)}>
                  Add item
                </Button>
              )}
              <Button kind="primary" size="md" onClick={() => buy.open({ projectId: project.id })}>
                Add purchases
              </Button>
            </div>
          </div>
          <div
            className="wg-pbar"
            role="img"
            aria-label={`Spent ${formatCents(spent)}, requested or approved ${formatCents(requested)}, not bought yet ${formatCents(notBought)}`}
          >
            <span className="wg-pbar__seg is-spent" style={{ flexGrow: spent / barTotal }} />
            <span className="wg-pbar__seg is-requested" style={{ flexGrow: requested / barTotal }} />
            <span className="wg-pbar__seg is-left" style={{ flexGrow: notBought / barTotal }} />
          </div>
          <p className="wg-pbar__legend">
            <span>Spent {formatCents(spent)}</span>
            <span>Requested or approved {formatCents(requested)}</span>
            <span>Not bought yet {formatCents(notBought)}</span>
          </p>

          {project.items.length === 0 ? (
            <p className="wg-empty">No items yet.</p>
          ) : (
            <div className="wg-cplan">
              <div className="wg-cplan__row wg-cplan__row--head" aria-hidden="true">
                <span>Item</span>
                <span>Planned</span>
                <span>Purchases</span>
                <span>Status</span>
              </div>
              {project.items.map((item) => {
                const itemPurchases = byItem(item.id);
                const status = itemStatus(item, itemPurchases);
                const active = itemPurchases.filter((p) => p.status !== 'declined');
                const picked = selected?.kind === 'item' && selected.id === item.id;
                return (
                  <div key={item.id}>
                    <button
                      type="button"
                      className={`wg-cplan__row${picked ? ' is-selected' : ''}`}
                      aria-pressed={picked}
                      onClick={() => setSelected({ kind: 'item', id: item.id })}
                    >
                      <span>
                        <strong>{item.text}</strong>
                        <small>{itemCaption(item, rules.data?.offersThreshold)}</small>
                      </span>
                      <span>{formatMoney(item.plannedAmount)}</span>
                      <span>{formatCents(active.reduce((sum, p) => sum + amountCents(p), 0))}</span>
                      <span>
                        <Tag size="sm" type={status.tag}>
                          {status.label}
                        </Tag>
                      </span>
                    </button>
                    {itemPurchases.map((purchase) => (
                      <PurchaseSubRow
                        key={purchase.id}
                        purchase={purchase}
                        picked={selected?.kind === 'purchase' && selected.id === purchase.id}
                        onSelect={() => setSelected({ kind: 'purchase', id: purchase.id })}
                      />
                    ))}
                  </div>
                );
              })}
              {loose.length > 0 && (
                <div>
                  <p className="wg-cplan__group">Not in the plan</p>
                  {loose.map((purchase) => (
                    <PurchaseSubRow
                      key={purchase.id}
                      purchase={purchase}
                      picked={selected?.kind === 'purchase' && selected.id === purchase.id}
                      onSelect={() => setSelected({ kind: 'purchase', id: purchase.id })}
                    />
                  ))}
                </div>
              )}
              <div className="wg-cplan__row wg-cplan__row--total">
                <span>Total</span>
                <span>{formatMoney(project.totals.planned)}</span>
                <span>{formatMoney(project.totals.inPurchases)}</span>
                <span />
              </div>
            </div>
          )}
        </section>

        <div className="wg-pj-side">
          {selectedItem && (
            <ProjectItemPanel
              key={selectedItem.id}
              project={project}
              item={selectedItem}
              purchases={byItem(selectedItem.id)}
              canPlan={canPlan}
              canBuy={canBuyItem}
              onBuy={makePurchase}
              onGone={() => setSelected(null)}
            />
          )}
          {selectedPurchase && (
            <PurchasePanel
              key={selectedPurchase.id}
              me={me.person.id}
              isLead={group?.isLead ?? false}
              finance={finance}
              purchase={selectedPurchase}
              onGone={() => setSelected(null)}
            />
          )}

          {finance && (
            <section className="wg-card" aria-label="Request for the WiRef">
              <h3>Request for the WiRef</h3>
              <p>
                <Tag size="sm" type={project.hasRequestPdf && !project.wirefRequestPending ? 'green' : 'gray'}>
                  {project.hasRequestPdf && !project.wirefRequestPending ? 'Sent' : 'Not sent yet'}
                </Tag>
              </p>
              {attachments.length > 0 && (
                <ul className="wg-plist">
                  {attachments.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              )}
              <div className="wg-panel-actions">
                <Button kind="tertiary" size="md" onClick={() => preview.open(true)}>
                  Preview the form
                </Button>
                {project.hasRequestPdf && (
                  <Button kind="ghost" size="md" onClick={() => sentPdf.open(true)}>
                    Show the sent form
                  </Button>
                )}
                {project.wirefRequestPending && (
                  <Button
                    kind="primary"
                    size="md"
                    disabled={sendWiRef.isPending}
                    onClick={() => sendWiRef.mutate(undefined)}
                  >
                    Send to the WiRef
                  </Button>
                )}
              </div>
            </section>
          )}

          <section className="wg-card" aria-label="About">
            <h3>About</h3>
            <p>{project.goal}</p>
            <p className="wg-muted">{project.benefit}</p>
            <dl className="wg-pa-facts">
              <dt>Planned income</dt>
              <dd>{formatMoney(project.plannedIncome)}</dd>
              <dt>People</dt>
              <dd>{project.people}</dd>
              <dt>Paid from</dt>
              <dd>
                {finance && !isEndState(project) ? (
                  <Select
                    id="wg-paid-from"
                    labelText="Paid from"
                    hideLabel
                    size="sm"
                    value={project.paidFrom ?? ''}
                    disabled={paidFrom.isPending}
                    onChange={(event) => {
                      if (event.target.value) paidFrom.mutate(event.target.value as WorkingGroupProjectPaidFrom);
                    }}
                  >
                    {!project.paidFrom && <SelectItem value="" text="Not decided yet" />}
                    {Object.entries(PAID_FROM_LABEL).map(([id, label]) => (
                      <SelectItem key={id} value={id} text={label} />
                    ))}
                  </Select>
                ) : (
                  paidFromLabel(project)
                )}
              </dd>
              <dt>WiRef number</dt>
              <dd>{project.wirefNumber || '–'}</dd>
              <dt>Advance</dt>
              <dd>
                {project.advanceRequested
                  ? `${project.advanceAmount ? formatMoney(project.advanceAmount) : 'Whole planned amount'}${project.advanceStatus === 'received' ? ' · arrived' : ''}`
                  : 'No'}
              </dd>
            </dl>
          </section>

          <section className="wg-card" aria-label="History">
            <h3>History</h3>
            <ol className="wg-plist">
              {history.map((entry) => (
                <li key={`${entry.status}-${entry.at}`}>
                  <span>
                    {HISTORY_LABEL[entry.status] ??
                      PROJECT_STATUS_LABEL[entry.status as WorkingGroupProject['status']] ??
                      entry.status}
                    {' · '}
                    {entry.actor?.displayName ?? 'Former member'}
                  </span>
                  <span>{formatDate(entry.at)}</span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>

      {edit.value && (
        <ProjectDialog
          groups={group ? [group] : []}
          initialGroupId={project.groupId}
          project={project}
          onClose={edit.close}
        />
      )}
      {addItem.value && <ItemDialog project={project} onClose={addItem.close} />}
      {approve.value && <ApproveDialog project={project} onClose={approve.close} />}
      {reason.value && <ReasonDialog project={project} mode={reason.value} onClose={reason.close} />}
      {wiref.value && <WiRefDecisionDialog project={project} onClose={wiref.close} />}
      {complete.value && <CompleteDialog project={project} onClose={complete.close} />}
      {buy.value && group && (
        <AddPurchasesDialog
          groups={[group]}
          initialGroupId={group.id}
          prefill={buy.value === 'plain' ? undefined : buy.value}
          onClose={buy.close}
        />
      )}
      {preview.value && (
        <FilePreview
          title="Projektantrag"
          cacheKey={`preview-${project.id}-${project.version}`}
          load={() => previewWorkingGroupProjectRequest(project.id, {})}
          downloadUrl={getDownloadWorkingGroupProjectRequestPdfUrl(project.id)}
          onClose={preview.close}
        />
      )}
      {sentPdf.value && (
        <FilePreview
          title="Projektantrag"
          cacheKey={`sent-${project.id}-${project.version}`}
          load={(signal) => downloadWorkingGroupProjectRequestPdf(project.id, { signal })}
          downloadUrl={getDownloadWorkingGroupProjectRequestPdfUrl(project.id)}
          onClose={sentPdf.close}
        />
      )}
    </PageShell>
  );
}

function PurchaseSubRow({
  purchase,
  picked,
  onSelect,
}: {
  purchase: WorkingGroupPurchase;
  picked: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={`wg-cplan__row wg-cplan__row--sub${picked ? ' is-selected' : ''}`}
      aria-pressed={picked}
      onClick={onSelect}
    >
      <span>
        {purchase.item}
        <small>{purchase.quantity} ×</small>
      </span>
      <span />
      <span>{formatCents(amountCents(purchase))}</span>
      <span>{PURCHASE_STATUS_LABEL[purchase.status]}</span>
    </button>
  );
}
