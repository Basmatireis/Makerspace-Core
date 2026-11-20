import { useMemo, useRef, useState } from 'react';
import { Button, InlineNotification, Modal, Search } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { WorkingGroupProject, WorkingGroupPurchase } from '../../api/generated/models';
import { BatchFilter, type FilterCategory, type FilterValues } from '../../app/BatchFilter';
import { DetailPanel, DetailPanelSection } from '../../app/components/DetailPanel';
import { ListWithPanel, useListPanelLayout } from '../../app/components/ListWithPanel';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { PageSectionTabs } from '../machinelogbook/components/machineParts';
import { formatCents, toCents } from '../orders/money';
import { BudgetCard, type Figures } from './BudgetParts';
import { ProjectDialog } from './ProjectDialogs';
import { ProjectPanel } from './ProjectParts';
import { PurchaseTrack } from './PurchaseList';
import { PurchasePanel } from './PurchasePanel';
import {
  PROJECT_BUCKETS,
  PROJECT_STATUS_LABEL,
  PROJECT_STEPS,
  dateRange,
  paidFromLabel,
  projectBucket,
  projectStage,
  who,
} from './projectModel';
import { projectsOptions } from './projectQueries';
import { COUNTS_LABEL, amountCents, countsAs, sortPeriods } from './financeModel';
import { budgetOptions, budgetPeriodsOptions, purchasesOptions } from './financeQueries';
import { orderGroups, workingGroupsOptions } from './queries';
import { Tile } from './TaskSummary';
import { formatDateOnly, personName } from './taskModel';
import { useDialogOpener } from './useDialogOpener';
import './workinggroups.scss';

const ALL = 'all';
const TITLE = 'Projects';
const CRUMBS = [{ label: 'Working groups', to: '/working-groups' }];
type Focus = 'waiting' | 'running' | null;

/** Working groups → Projects: what groups plan, what is decided and what is running. */
export function ProjectsPage() {
  const currentUser = useCurrentUser();
  const finance = hasPermission(currentUser, PermissionId.working_group_financesmanage);
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const groupsQuery = useQuery(workingGroupsOptions);
  const periodsQuery = useQuery(budgetPeriodsOptions);
  const groups = useMemo(() => orderGroups(groupsQuery.data?.items ?? []), [groupsQuery.data]);
  const own = groups.filter((group) => group.isMember || group.isLead);
  const visibleGroups = finance ? groups : own;
  const requested = params.get('group');
  const scope =
    finance && requested === ALL
      ? ALL
      : visibleGroups.some((group) => group.id === requested)
        ? (requested as string)
        : (own[0]?.id ?? (finance ? ALL : ''));
  const groupId = scope === ALL || scope === '' ? undefined : scope;
  const selectedGroup = groups.find((group) => group.id === groupId);
  // Only members of a group start its projects, whatever the group filter shows.
  const startGroups = selectedGroup ? own.filter((group) => group.id === selectedGroup.id) : own;

  const periods = useMemo(() => sortPeriods(periodsQuery.data?.items ?? []), [periodsQuery.data]);
  const [chosenPeriod, setChosenPeriod] = useState<string | null>(null);
  const period =
    periods.find((candidate) => candidate.id === chosenPeriod) ?? periods.find((p) => p.current) ?? periods[0];
  const periodId = period?.id;

  const projectsQuery = useQuery({ ...projectsOptions({ groupId }), enabled: visibleGroups.length > 0 });
  const budgetQuery = useQuery({ ...budgetOptions({ periodId }), enabled: periodId !== undefined });
  const purchasesQuery = useQuery({ ...purchasesOptions({ groupId, periodId }), enabled: periodId !== undefined });

  const [focus, setFocus] = useState<Focus>(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<FilterValues>({});
  const [selected, setSelected] = useState<{ kind: 'project' | 'purchase'; id: string } | null>(null);
  const start = useDialogOpener();
  const rowOpener = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelFits = useListPanelLayout();

  const projects = useMemo(() => projectsQuery.data?.items ?? [], [projectsQuery.data]);
  const purchases = useMemo(() => purchasesQuery.data?.items ?? [], [purchasesQuery.data]);
  const byProject = useMemo(() => {
    const map = new Map<string, WorkingGroupPurchase[]>();
    for (const purchase of purchases) {
      if (!purchase.projectId) continue;
      map.set(purchase.projectId, [...(map.get(purchase.projectId) ?? []), purchase]);
    }
    return map;
  }, [purchases]);
  const needle = search.trim().toLowerCase();

  const shown = projects.filter((project) => {
    if (
      needle &&
      !`${project.title} ${project.requester?.displayName ?? ''} ${project.groupName}`.toLowerCase().includes(needle)
    ) {
      return false;
    }
    const status = filters.status ?? [];
    const paid = filters.paidFrom ?? [];
    if (status.length > 0 && !status.includes(project.status)) return false;
    if (paid.length > 0 && !paid.includes(project.paidFrom ?? 'undecided')) return false;
    if (focus === 'waiting' && projectBucket(project) !== 'waiting') return false;
    if (focus === 'running' && project.status !== 'running') return false;
    return true;
  });

  const setGroup = (id: string) => {
    setSelected(null);
    setFocus(null);
    setFilters({});
    setParams(
      (previous) => {
        const updated = new URLSearchParams(previous);
        updated.set('group', id);
        return updated;
      },
      { replace: true },
    );
  };

  if (groupsQuery.isPending || periodsQuery.isPending) {
    return (
      <PageShell title={TITLE} breadcrumbs={CRUMBS}>
        <InlineLoadingState label="Loading projects" />
      </PageShell>
    );
  }
  if (groupsQuery.isError || periodsQuery.isError) {
    return (
      <PageShell title={TITLE} breadcrumbs={CRUMBS}>
        <ErrorState title="Projects unavailable" message="Reload the page to try again." />
      </PageShell>
    );
  }
  if (visibleGroups.length === 0) {
    return (
      <PageShell title={TITLE} breadcrumbs={CRUMBS}>
        <EmptyState title="Projects are for the members of a working group." />
      </PageShell>
    );
  }

  const budget = budgetQuery.data;
  const share = budget?.groups.find((entry) => entry.groupId === groupId);
  let figures: Figures | null = null;
  if (groupId === undefined && budget?.totals) {
    figures = {
      given: toCents(budget.totals.givenSum),
      spent: toCents(budget.totals.spentSum),
      reserved: toCents(budget.totals.reservedSum),
      free: toCents(budget.totals.freeSum),
      kept: toCents(budget.totals.keptBack),
    };
  } else if (share) {
    figures = {
      given: toCents(share.given),
      spent: toCents(share.spent),
      reserved: toCents(share.reserved),
      free: toCents(share.free),
    };
  }

  const waiting = projects.filter((project) => projectBucket(project) === 'waiting');
  const toDecide = waiting.filter((project) => project.canDecide);
  const running = projects.filter((project) => project.status === 'running');
  const filterCategories: FilterCategory[] = [
    {
      key: 'status',
      label: 'Status',
      options: Object.entries(PROJECT_STATUS_LABEL).map(([id, label]) => ({ id, label })),
    },
    {
      key: 'paidFrom',
      label: 'Paid from',
      options: [
        { id: 'group', label: 'Group budget' },
        { id: 'external', label: 'External source' },
        { id: 'undecided', label: 'Not decided yet' },
      ],
    },
  ];

  const selectedProject = selected?.kind === 'project' ? projects.find((p) => p.id === selected.id) : undefined;
  const selectedPurchase = selected?.kind === 'purchase' ? purchases.find((p) => p.id === selected.id) : undefined;
  const panel = selectedPurchase ? (
    <PurchasePanel
      key={selectedPurchase.id}
      me={currentUser.person.id}
      isLead={groups.find((group) => group.id === selectedPurchase.groupId)?.isLead ?? false}
      finance={finance}
      purchase={selectedPurchase}
      onGone={() => setSelected(null)}
      onClose={panelFits ? () => setSelected(null) : undefined}
    />
  ) : selectedProject ? (
    <ProjectPanel
      key={selectedProject.id}
      project={selectedProject}
      purchases={byProject.get(selectedProject.id) ?? []}
      onSelectPurchase={(id) => setSelected({ kind: 'purchase', id })}
      onClose={panelFits ? () => setSelected(null) : undefined}
    />
  ) : (
    <DetailPanel>
      <DetailPanelSection>
        <p className="wg-placeholder__title">Nothing selected</p>
        <p className="wg-muted">Pick a project.</p>
      </DetailPanelSection>
    </DetailPanel>
  );

  const select = (kind: 'project' | 'purchase', id: string) => {
    rowOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSelected({ kind, id });
  };
  const sections = PROJECT_BUCKETS.map((bucket) => ({
    ...bucket,
    items: shown.filter((project) => projectBucket(project) === bucket.key),
  })).filter((entry) => entry.items.length > 0);

  return (
    <PageShell
      title={TITLE}
      width="wide"
      breadcrumbs={[
        ...CRUMBS,
        { label: selectedGroup?.name ?? 'All groups', to: `/working-groups/projects?group=${scope}` },
      ]}
      tabs={
        <PageSectionTabs
          label="Working groups"
          sections={[
            ...(finance ? [{ id: ALL, label: 'All groups' }] : []),
            ...visibleGroups.map((group) => ({ id: group.id, label: group.name })),
          ]}
          selected={scope}
          onChange={setGroup}
        />
      }
    >
      <div className="wg-summary wg-summary--panel">
        {figures && period ? (
          <BudgetCard
            label="Budget"
            figures={figures}
            periods={periods}
            periodId={period.id}
            onPeriod={(id) => {
              setChosenPeriod(id);
              setSelected(null);
            }}
            focus={null}
            onFocus={() => undefined}
          />
        ) : (
          <section className="wg-sbar" aria-label="Budget">
            {budgetQuery.isError ? <p>The budget could not be loaded.</p> : <p className="wg-muted">Loading…</p>}
          </section>
        )}
        <Tile
          title={finance ? 'Waiting for you' : 'Waiting for approval'}
          count={finance ? toDecide.length : waiting.length}
          pressed={focus === 'waiting'}
          onClick={() => setFocus(focus === 'waiting' ? null : 'waiting')}
          rows={
            finance
              ? [
                  ['To decide', String(waiting.filter((p) => p.status === 'submitted').length)],
                  ['To send to the WiRef', String(waiting.filter((p) => p.wirefRequestPending).length)],
                ]
              : [
                  ['Projects', String(waiting.length)],
                  ['Planned', formatCents(waiting.reduce((sum, p) => sum + toCents(p.totals.planned), 0))],
                ]
          }
        />
        <Tile
          title="Running"
          count={running.length}
          pressed={focus === 'running'}
          onClick={() => setFocus(focus === 'running' ? null : 'running')}
          rows={[
            ['Planned', formatCents(running.reduce((sum, p) => sum + toCents(p.totals.planned), 0))],
            ['Bought so far', formatCents(running.reduce((sum, p) => sum + toCents(p.totals.spent), 0))],
          ]}
        />
      </div>

      <ListWithPanel panel={panel} panelLabel="Project details">
        <div className="wg-card-list" ref={listRef} tabIndex={-1}>
          <div className="wg-toolbar">
            <div className="wg-toolbar__search">
              <Search
                id="wg-project-search"
                size="md"
                labelText="Search projects"
                placeholder="Search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                onClear={() => setSearch('')}
              />
            </div>
            <BatchFilter
              id="wg-projects"
              label="Projects"
              categories={filterCategories}
              applied={filters}
              onApply={setFilters}
              onReset={() => setFilters({})}
            />
            <div className="wg-toolbar__actions">
              {startGroups.length > 0 ? (
                <Button kind="primary" size="md" onClick={() => start.open(true)}>
                  Start a project
                </Button>
              ) : (
                <span className="wg-muted wg-toolbar__note">Only members of a working group can start projects.</span>
              )}
            </div>
          </div>
          {projectsQuery.data?.truncated && (
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="Not all projects are shown."
              subtitle="Narrow it down by group."
            />
          )}
          {projectsQuery.isError && <p className="wg-empty">The projects could not be loaded.</p>}
          {projectsQuery.isPending ? (
            <InlineLoadingState label="Loading projects" />
          ) : sections.length === 0 ? (
            <p className="wg-empty">Nothing matches.</p>
          ) : (
            <div className="wg-list">
              <div className="wg-lrow wg-prow wg-prow--group wg-lrow--head" aria-hidden="true">
                <span>Planned</span>
                <span>Project</span>
                <span>Paid from</span>
                <span>Stage</span>
              </div>
              {sections.map((section) => (
                <section key={section.key} aria-labelledby={`wg-jgroup-${section.key}`}>
                  <h3 id={`wg-jgroup-${section.key}`} className="wg-lweek">
                    {section.label} <small>{section.items.length}</small>
                  </h3>
                  <ul className="wg-llist">
                    {section.items.map((project) => (
                      <ProjectRow
                        key={project.id}
                        project={project}
                        showGroup={groupId === undefined}
                        purchases={byProject.get(project.id) ?? []}
                        selected={selected}
                        onSelect={select}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      </ListWithPanel>

      {!panelFits && (selectedProject || selectedPurchase) && (
        <Modal
          open
          passiveModal
          size="md"
          modalHeading={selectedPurchase ? 'Purchase' : 'Project'}
          onRequestClose={() => {
            setSelected(null);
            window.setTimeout(() => rowOpener.current?.focus(), 0);
          }}
        >
          {panel}
        </Modal>
      )}

      {start.value && startGroups.length > 0 && (
        <ProjectDialog
          groups={startGroups}
          initialGroupId={selectedGroup?.id ?? ''}
          onClose={start.close}
          onSaved={(created) => void navigate(`/working-groups/projects/${created.id}`)}
        />
      )}
    </PageShell>
  );
}

function ProjectRow({
  project,
  showGroup,
  purchases,
  selected,
  onSelect,
}: {
  project: WorkingGroupProject;
  showGroup: boolean;
  purchases: readonly WorkingGroupPurchase[];
  selected: { kind: string; id: string } | null;
  onSelect: (kind: 'project' | 'purchase', id: string) => void;
}) {
  const stage = projectStage(project);
  const running = project.status === 'running' || project.status === 'completed';
  const isSelected = selected?.kind === 'project' && selected.id === project.id;
  const detail = [who(project), dateRange(project, formatDateOnly), showGroup ? project.groupName : '']
    .filter(Boolean)
    .join(' · ');
  return (
    <li>
      <button
        type="button"
        className={`wg-lrow wg-prow wg-prow--group${isSelected ? ' is-selected' : ''}`}
        aria-pressed={isSelected}
        onClick={() => onSelect('project', project.id)}
      >
        <span className="wg-pamount">
          <strong>{formatCents(toCents(project.totals.planned))}</strong>
          <small>{running ? `${formatCents(toCents(project.totals.spent))} spent` : 'Not counted yet'}</small>
        </span>
        <span className="wg-lwhat">
          <span className="wg-lwhat__title">{project.title}</span>
          <small>{detail}</small>
        </span>
        <span className="wg-lfrom">{paidFromLabel(project)}</span>
        <span
          className={`wg-track${stage.declined ? ' is-declined' : ''}${stage.index === PROJECT_STEPS.length - 1 && !stage.declined ? ' is-done' : ''}`}
          role="img"
          aria-label={`Stage: ${stage.label}, step ${stage.index + 1} of ${PROJECT_STEPS.length}`}
        >
          <span className="wg-track__bar wg-track__bar--5" aria-hidden="true">
            {PROJECT_STEPS.map((step, index) => (
              <i key={step} className={index < stage.index ? 'is-past' : index === stage.index ? 'is-now' : ''} />
            ))}
          </span>
          <span className="wg-track__l" aria-hidden="true">
            {stage.label}
          </span>
        </span>
      </button>
      {purchases.length > 0 && (
        <ul className="wg-sublist">
          {purchases.map((purchase) => {
            const picked = selected?.kind === 'purchase' && selected.id === purchase.id;
            return (
              <li key={purchase.id}>
                <button
                  type="button"
                  className={`wg-lrow wg-prow wg-prow--group wg-subrow${picked ? ' is-selected' : ''}`}
                  aria-pressed={picked}
                  onClick={() => onSelect('purchase', purchase.id)}
                >
                  <span className="wg-pamount">
                    <strong>{formatCents(amountCents(purchase))}</strong>
                    <small>{COUNTS_LABEL[countsAs(purchase)]}</small>
                  </span>
                  <span className="wg-lwhat wg-tree">
                    <span className="wg-lwhat__title">{purchase.item}</span>
                    <small>
                      Purchase · {purchase.quantity} × ·{' '}
                      {purchase.requester ? personName(purchase.requester) : 'Former member'}
                    </small>
                  </span>
                  <span className="wg-lfrom">
                    {purchase.how === 'self' ? 'Bought by a member' : 'Collective order'}
                  </span>
                  <PurchaseTrack purchase={purchase} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}
