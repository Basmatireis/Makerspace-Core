import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, InlineNotification, Modal, Search } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { BatchFilter, type FilterCategory, type FilterValues } from '../../app/BatchFilter';
import { DetailPanel, DetailPanelSection } from '../../app/components/DetailPanel';
import { ListWithPanel, useListPanelLayout } from '../../app/components/ListWithPanel';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { PageSectionTabs } from '../machinelogbook/components/machineParts';
import { formatCents, toCents } from '../orders/money';
import { BudgetCard, type Figures, type MoneyFocus } from './BudgetParts';
import { CollectiveOrder } from './CollectiveOrder';
import { FinanceRulesDialog } from './FinanceRulesDialog';
import { BookingPanel } from './BookingPanel';
import { BookCostDialog } from './FinanceExtraDialogs';
import { AddPurchasesDialog } from './PurchaseDialogs';
import { PurchaseList } from './PurchaseList';
import { PurchasePanel } from './PurchasePanel';
import {
  COUNTS_LABEL,
  PURCHASE_STATUS_LABEL,
  amountCents,
  countsAs,
  sortPeriods,
  turnOf,
  type FinanceRow,
} from './financeModel';
import { bookingsOptions, budgetOptions, budgetPeriodsOptions, purchasesOptions } from './financeQueries';
import { orderGroups, workingGroupsOptions } from './queries';
import { Tile } from './TaskSummary';
import { useDialogOpener } from './useDialogOpener';
import './workinggroups.scss';

type Focus = MoneyFocus | 'waiting' | 'turn';
const ALL = 'all';

const TITLE = 'Purchases';
const CRUMBS = [{ label: 'Working groups', to: '/working-groups' }];

/** Working groups → Purchases: what groups want, buy and have bought, against their budget. */
export function PurchasesPage() {
  const currentUser = useCurrentUser();
  const finance = hasPermission(currentUser, PermissionId.working_group_financesmanage);
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

  const periods = useMemo(() => sortPeriods(periodsQuery.data?.items ?? []), [periodsQuery.data]);
  const [chosenPeriod, setChosenPeriod] = useState<string | null>(null);
  const period =
    periods.find((candidate) => candidate.id === chosenPeriod) ?? periods.find((p) => p.current) ?? periods[0];
  const periodId = period?.id;

  const budgetQuery = useQuery({ ...budgetOptions({ periodId }), enabled: periodId !== undefined });
  const purchasesQuery = useQuery({ ...purchasesOptions({ groupId, periodId }), enabled: periodId !== undefined });
  const bookingsQuery = useQuery({ ...bookingsOptions({ groupId, periodId }), enabled: periodId !== undefined });

  const [focus, setFocus] = useState<Focus>(null);
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<FilterValues>({});
  const [view, setView] = useState<'list' | 'order'>('list');
  const [selectedId, setSelectedId] = useState<string | null>(() => params.get('item'));
  const add = useDialogOpener();
  const rules = useDialogOpener();
  const book = useDialogOpener();
  const rowOpener = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const panelFits = useListPanelLayout();

  const purchases = useMemo(() => purchasesQuery.data?.items ?? [], [purchasesQuery.data]);
  const bookings = useMemo(() => bookingsQuery.data?.items ?? [], [bookingsQuery.data]);
  const needle = search.trim().toLowerCase();

  const rows = useMemo<FinanceRow[]>(() => {
    const statusFilter = filters.status ?? [];
    const howFilter = filters.how ?? [];
    const countsFilter = filters.counts ?? [];
    const result: FinanceRow[] = [];
    for (const purchase of purchases) {
      const counts = countsAs(purchase);
      if (
        needle &&
        !`${purchase.item} ${purchase.requester?.displayName ?? ''} ${purchase.groupName}`
          .toLowerCase()
          .includes(needle)
      ) {
        continue;
      }
      if (statusFilter.length > 0 && !statusFilter.includes(purchase.status)) continue;
      if (howFilter.length > 0 && !howFilter.includes(purchase.how)) continue;
      if (countsFilter.length > 0 && !countsFilter.includes(counts)) continue;
      if ((focus === 'spent' || focus === 'reserved') && counts !== focus) continue;
      if (focus === 'waiting' && purchase.status !== 'wanted') continue;
      if (focus === 'turn' && turnOf(purchase) === null) continue;
      result.push({ kind: 'purchase', id: purchase.id, purchase });
    }
    const bookingsShown =
      statusFilter.length === 0 &&
      howFilter.length === 0 &&
      (countsFilter.length === 0 || countsFilter.includes('spent')) &&
      (focus === null || focus === 'spent');
    if (bookingsShown) {
      for (const booking of bookings) {
        if (needle && !`${booking.text} ${booking.groupName}`.toLowerCase().includes(needle)) continue;
        result.push({ kind: 'booking', id: booking.id, booking });
      }
    }
    return result;
  }, [purchases, bookings, needle, filters, focus]);

  const selected = purchases.find((purchase) => purchase.id === selectedId) ?? null;
  const selectedBooking = bookings.find((booking) => booking.id === selectedId) ?? null;
  const loaded = purchasesQuery.isSuccess;
  useEffect(() => {
    if (loaded && selectedId !== null && selected === null && selectedBooking === null) {
      setSelectedId(null);
      listRef.current?.focus();
    }
  }, [loaded, selectedId, selected, selectedBooking]);

  const setGroup = (id: string) => {
    setSelectedId(null);
    setFocus(null);
    setFilters({});
    setView('list');
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
        <InlineLoadingState label="Loading purchases" />
      </PageShell>
    );
  }
  if (groupsQuery.isError || periodsQuery.isError) {
    return (
      <PageShell title={TITLE} breadcrumbs={CRUMBS}>
        <ErrorState title="Purchases unavailable" message="Reload the page to try again." />
      </PageShell>
    );
  }
  if (visibleGroups.length === 0) {
    return (
      <PageShell title={TITLE} breadcrumbs={CRUMBS}>
        <EmptyState title="Purchases are for the members of a working group." />
      </PageShell>
    );
  }
  if (!period) {
    return (
      <PageShell title={TITLE} breadcrumbs={CRUMBS}>
        <EmptyState
          title="No budget period yet"
          description={finance ? 'Create one on the Budget page.' : 'Management has not created one yet.'}
        />
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

  const waiting = purchases.filter((purchase) => purchase.status === 'wanted');
  const waitingTotal = waiting.reduce((sum, purchase) => sum + amountCents(purchase), 0);
  const turn = purchases.map(turnOf).filter((kind) => kind !== null);
  const collective = finance && groupId === undefined;
  const orderWaiting = purchases.filter(
    (purchase) => purchase.how === 'central' && purchase.status === 'approved' && !purchase.orderId,
  );

  const filterCategories: FilterCategory[] = [
    {
      key: 'status',
      label: 'Status',
      options: Object.entries(PURCHASE_STATUS_LABEL).map(([id, label]) => ({ id, label })),
    },
    {
      key: 'how',
      label: 'How',
      options: [
        { id: 'central', label: 'Collective order' },
        { id: 'self', label: 'Buys it themselves' },
      ],
    },
    {
      key: 'counts',
      label: 'Counts as',
      options: Object.entries(COUNTS_LABEL).map(([id, label]) => ({ id, label })),
    },
  ];

  // Booking a cost is for finance managers in any group; requesting purchases only for the groups the caller is in.
  const addGroups = selectedGroup ? [selectedGroup] : visibleGroups;
  const requestGroups = selectedGroup ? own.filter((group) => group.id === selectedGroup.id) : own;
  const goneAfterDelete = () => {
    setSelectedId(null);
    listRef.current?.focus();
  };
  const panel = selectedBooking ? (
    <BookingPanel key={selectedBooking.id} booking={selectedBooking} finance={finance} onGone={goneAfterDelete} />
  ) : selected ? (
    <PurchasePanel
      key={selected.id}
      me={currentUser.person.id}
      isLead={groups.find((group) => group.id === selected.groupId)?.isLead ?? false}
      finance={finance}
      purchase={selected}
      onGone={() => {
        setSelectedId(null);
        listRef.current?.focus();
      }}
    />
  ) : (
    <DetailPanel>
      <DetailPanelSection>
        <p className="wg-placeholder__title">Nothing selected</p>
        <p className="wg-muted">Pick a purchase.</p>
      </DetailPanelSection>
    </DetailPanel>
  );

  return (
    <PageShell
      title={TITLE}
      width="wide"
      breadcrumbs={[
        ...CRUMBS,
        { label: selectedGroup?.name ?? 'All groups', to: `/working-groups/purchases?group=${scope}` },
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
      <div className="wg-summary">
        {figures ? (
          <BudgetCard
            label="Budget"
            figures={figures}
            periods={periods}
            periodId={period.id}
            onPeriod={(id) => {
              setChosenPeriod(id);
              setSelectedId(null);
            }}
            focus={focus === 'spent' || focus === 'reserved' ? focus : null}
            onFocus={(next) => {
              setView('list');
              setFocus(next);
            }}
          />
        ) : (
          <section className="wg-sbar" aria-label="Budget">
            {budgetQuery.isError ? <p>The budget could not be loaded.</p> : <p className="wg-muted">Loading…</p>}
          </section>
        )}
        <Tile
          title="Waiting for approval"
          count={waiting.length}
          pressed={focus === 'waiting'}
          onClick={() => {
            setView('list');
            setFocus(focus === 'waiting' ? null : 'waiting');
          }}
          rows={[
            ['Items', String(waiting.length)],
            ['Total', formatCents(waitingTotal)],
            ['Need a project', String(waiting.filter((purchase) => purchase.needsProject).length)],
          ]}
        />
        {collective ? (
          <Tile
            title="Collective order"
            count={orderWaiting.length}
            pressed={view === 'order'}
            onClick={() => setView(view === 'order' ? 'list' : 'order')}
            rows={[
              ['Items', String(orderWaiting.length)],
              ['Total', formatCents(orderWaiting.reduce((sum, purchase) => sum + amountCents(purchase), 0))],
            ]}
          />
        ) : (
          <Tile
            title="Your turn"
            count={turn.length}
            pressed={focus === 'turn'}
            onClick={() => {
              setView('list');
              setFocus(focus === 'turn' ? null : 'turn');
            }}
            rows={[
              ['Hand in a receipt', String(turn.filter((kind) => kind === 'receipt').length)],
              ['Mark as arrived', String(turn.filter((kind) => kind === 'arrived').length)],
              ['Money to return', String(turn.filter((kind) => kind === 'refund').length)],
              ['Approve', String(turn.filter((kind) => kind === 'approve').length)],
            ]}
          />
        )}
      </div>

      {view === 'order' && collective ? (
        <CollectiveOrder purchases={purchases} period={period} />
      ) : (
        <ListWithPanel panel={panel} panelLabel="Purchase details">
          <div className="wg-card-list" ref={listRef} tabIndex={-1}>
            <div className="wg-toolbar">
              <div className="wg-toolbar__search">
                <Search
                  id="wg-purchase-search"
                  size="md"
                  labelText="Search purchases"
                  placeholder="Search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  onClear={() => setSearch('')}
                />
              </div>
              <BatchFilter
                id="wg-purchases"
                label="Purchases"
                categories={filterCategories}
                applied={filters}
                onApply={setFilters}
                onReset={() => setFilters({})}
              />
              <div className="wg-toolbar__actions">
                {collective && (
                  <Button kind="tertiary" size="md" onClick={() => rules.open(true)}>
                    Rules and limits
                  </Button>
                )}
                {finance && (
                  <Button kind="tertiary" size="md" onClick={() => book.open(true)}>
                    Book a cost
                  </Button>
                )}
                {requestGroups.length > 0 ? (
                  <Button kind="primary" size="md" onClick={() => add.open(true)}>
                    Add purchases
                  </Button>
                ) : (
                  <span className="wg-muted wg-toolbar__note">
                    Only members of a working group can request purchases.
                  </span>
                )}
              </div>
            </div>
            {purchasesQuery.data?.truncated && (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title="Not all purchases are shown."
                subtitle="Narrow it down by group or period."
              />
            )}
            {purchasesQuery.isError && <p className="wg-empty">The purchases could not be loaded.</p>}
            {purchasesQuery.isPending ? (
              <InlineLoadingState label="Loading purchases" />
            ) : (
              <PurchaseList
                rows={rows}
                showGroup={groupId === undefined}
                selectedId={selectedId}
                onSelect={(id) => {
                  rowOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
                  setSelectedId(id);
                }}
              />
            )}
          </div>
        </ListWithPanel>
      )}

      {view === 'list' && !panelFits && (selected || selectedBooking) && (
        <Modal
          open
          passiveModal
          size="md"
          modalHeading="Purchase"
          onRequestClose={() => {
            setSelectedId(null);
            window.setTimeout(() => rowOpener.current?.focus(), 0);
          }}
        >
          {panel}
        </Modal>
      )}

      {add.value && requestGroups.length > 0 && (
        <AddPurchasesDialog groups={requestGroups} initialGroupId={selectedGroup?.id ?? ''} onClose={add.close} />
      )}
      {book.value && (
        <BookCostDialog
          groups={addGroups}
          initialGroupId={selectedGroup?.id ?? ''}
          periodId={period.id}
          onClose={book.close}
        />
      )}
      {rules.value && <FinanceRulesDialog onClose={rules.close} />}
    </PageShell>
  );
}
