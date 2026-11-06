import './opendays.scss';
import { useMemo, useReducer, useRef, useState } from 'react';
import { InlineNotification, OverflowMenu, OverflowMenuItem, Select, SelectItem, Tag } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { saveOpenDaySchedule } from '../../api/generated/open-days/open-days';
import type { OpenDay } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { UnsavedChangesDialog } from '../../app/UnsavedChangesDialog';
import { useNotify } from '../../app/toasts';
import { useNow } from '../../app/useNow';
import { useUnsavedChanges } from '../../app/useUnsavedChanges';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';
import { personalDashboardOptions } from '../dashboard/queries';
import { CalendarView } from './components/CalendarView';
import { ConfirmRemove, type RemovalRequest } from './components/ConfirmRemove';
import { glanceTiles } from './components/glance';
import { GlanceTiles } from './components/GlanceTiles';
import { ListView } from './components/ListView';
import { PanelFrame } from '../../app/components/PanelFrame';
import { SaveBar } from './components/SaveBar';
import { ScheduleToolbar, type ScheduleView } from './components/ScheduleToolbar';
import { SectionTabs } from './components/SectionTabs';
import { PANEL_DOCK_QUERY, useMediaQuery } from '../../app/components/useMediaQuery';
import { applyBulk, type BulkPatch } from './model/bulk';
import { addCalendarDays } from '../../app/dateTime';
import {
  clockOf,
  dateOf,
  dayMonth,
  dayMonthYear,
  longDate,
  plural,
  shortDate,
  timeRange,
  weekdayName,
} from './model/dates';
import { buildDelta } from './model/delta';
import { deriveSchedule } from './model/derive';
import { dayMatchesSearch, dayPasses, filterDefs, type FilterValues } from './model/filters';
import { findOverlap } from './model/overlap';
import { inSection, sectionDefs, type SectionId } from './model/sections';
import { slotSummary } from './model/timeslots';
import { DEFAULT_WARNING_DAYS, dayEnded, viewerOf, type StateContext } from './model/state';
import {
  editCount,
  editorReducer,
  initialEditorState,
  valuesOfDay,
  valuesOfSeries,
  type DayValues,
  type SeriesValues,
} from './model/workingCopy';
import { AddOpenDaysDialog } from './panels/AddOpenDaysDialog';
import { AssignPanel } from './panels/AssignPanel';
import { BulkPanel } from './panels/BulkPanel';
import { DayForm } from './panels/DayForm';
import { DayPanel } from './panels/DayPanel';
import { SeriesForm } from './panels/SeriesForm';
import {
  calendarContextQueryOptions,
  eligibilityRolesQueryOptions,
  openDayKeys,
  periodsQueryOptions,
  scheduleQueryOptions,
  seriesQueryOptions,
  staffingRowsQueryOptions,
} from './queries';
import { scheduleErrorMessage } from './scheduleErrors';
import { STATUS_TAG } from './periods/status';
import { useDayActions } from './useDayActions';

const VIEW_KEY = 'od-view';
const EMPTY: never[] = [];

// The list/calendar choice is a per-viewer convenience; storage can be unavailable (private windows), so it is optional.
function readView(): ScheduleView {
  try {
    return window.localStorage.getItem(VIEW_KEY) === 'calendar' ? 'calendar' : 'list';
  } catch {
    return 'list';
  }
}

type Panel =
  | { kind: 'view' }
  | { kind: 'assign'; slotId: string; requirementId: string }
  | { kind: 'edit' }
  | { kind: 'series'; id: string };

export function SchedulePage({ periodId }: { periodId: string }) {
  const user = useCurrentUser();
  const viewer = useMemo(() => viewerOf(user), [user]);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const nowMs = useNow();
  // The clock is part of memo keys below; it only changes once a minute.
  const now = useMemo(() => new Date(nowMs), [nowMs]);
  const docked = useMediaQuery(PANEL_DOCK_QUERY);
  const actions = useDayActions();

  const scheduleQuery = useQuery(scheduleQueryOptions(periodId));
  const contextQuery = useQuery(calendarContextQueryOptions(periodId));
  const seriesQuery = useQuery({ ...seriesQueryOptions(periodId), enabled: viewer.canManage });
  const rolesQuery = useQuery(eligibilityRolesQueryOptions(viewer.canManage));
  const dashboardQuery = useQuery({ ...personalDashboardOptions, enabled: viewer.canSignUp });
  const rowsQuery = useQuery({
    ...staffingRowsQueryOptions(periodId),
    enabled: hasPermission(user, 'supervisor_dashboard.read'),
  });
  const periodsQuery = useQuery({ ...periodsQueryOptions(), enabled: !viewer.canManage });

  const [section, setSection] = useState<SectionId>('upcoming');
  const [view, setViewState] = useState<ScheduleView>(readView);
  const [filters, setFilters] = useState<FilterValues>({});
  const [search, setSearch] = useState('');
  const [showEarlier, setShowEarlier] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(params.get('day'));
  const [panel, setPanel] = useState<Panel>(() =>
    params.get('series') ? { kind: 'series', id: params.get('series') ?? '' } : { kind: 'view' },
  );
  const [selecting, setSelecting] = useState(false);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [bulkSheet, setBulkSheet] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [removal, setRemoval] = useState<RemovalRequest | null>(null);
  const [saveError, setSaveError] = useState('');
  const [editor, dispatch] = useReducer(editorReducer, initialEditorState);
  const keyCounter = useRef(0);
  const guard = useUnsavedChanges({
    isDirty: editCount(editor.edits) > 0,
    onDiscard: () => dispatch({ type: 'reset' }),
  });

  const schedule = scheduleQuery.data;
  const period = schedule?.period;
  const draft = period?.status === 'draft';
  const savedSeries = seriesQuery.data?.items ?? EMPTY;
  const entries = contextQuery.data?.entries ?? EMPTY;
  const derived = useMemo(
    () =>
      schedule
        ? deriveSchedule({
            days: schedule.items,
            series: savedSeries,
            edits: editor.edits,
            entries,
            periodId,
            draft: schedule.period.status === 'draft',
            now,
          })
        : null,
    [schedule, savedSeries, editor.edits, entries, periodId, now],
  );
  const warningDays =
    rowsQuery.data?.rules.warningWindowDays ?? dashboardQuery.data?.staffing?.warningWindowDays ?? DEFAULT_WARNING_DAYS;
  const ctx: StateContext = useMemo(() => ({ viewer, now, warningDays }), [viewer, now, warningDays]);
  const days = derived?.days ?? EMPTY;
  const changes = derived?.changes ?? new Map();
  const rows = useMemo(
    () => new Map((rowsQuery.data?.supervisors ?? []).map((row) => [row.personId, row])),
    [rowsQuery.data],
  );
  const roles = rolesQuery.data?.items ?? EMPTY;
  const roleNames = useMemo(() => new Map(roles.map((role) => [role.id, role.name])), [roles]);
  const seriesLabels = useMemo(
    () =>
      new Map(
        (derived?.series ?? []).map((item) => [
          item.id,
          `Every ${weekdayName(item.weekday)} · ${slotSummary(item.slots)}`,
        ]),
      ),
    [derived],
  );

  const sections = useMemo(() => sectionDefs(days, viewer, now), [days, viewer, now]);
  const activeSection = sections.some((item) => item.id === section) ? section : 'upcoming';
  const shown = useMemo(
    () =>
      days
        .filter(
          (day) => inSection(day, activeSection, now) && dayPasses(day, filters, now) && dayMatchesSearch(day, search),
        )
        .sort((a, b) =>
          activeSection === 'past' ? b.startsAt.localeCompare(a.startsAt) : a.startsAt.localeCompare(b.startsAt),
        ),
    [days, activeSection, filters, search, now],
  );
  const matching = useMemo(() => new Set(shown.map((day) => day.id)), [shown]);
  const defs = useMemo(() => filterDefs(days, viewer), [days, viewer]);
  const selected = days.find((day) => day.id === selectedId) ?? null;
  const count = editCount(editor.edits);

  const setView = (next: ScheduleView) => {
    setViewState(next);
    try {
      window.localStorage.setItem(VIEW_KEY, next);
    } catch {
      /* the choice is only remembered when storage is available */
    }
  };
  const select = (id: string) => {
    setSelectedId(id);
    setPanel({ kind: 'view' });
  };
  const closePanel = () => {
    setSelectedId(null);
    setPanel({ kind: 'view' });
    setBulkSheet(false);
  };
  const toggleChecked = (id: string) =>
    setChecked((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const openDay = (id: string) => (selecting ? toggleChecked(id) : select(id));
  const toggleSelecting = () => {
    setSelecting((value) => !value);
    setChecked(new Set());
    setBulkSheet(false);
    setSelectedId(null);
    setPanel({ kind: 'view' });
  };

  const isLocked = (day: OpenDay) => {
    const change = changes.get(day.id);
    return day.id.startsWith('gen-') || (change === 'series' && !day.id.startsWith('new-')) || change === 'cancelled';
  };
  const editable = (day: OpenDay) => day.status === 'scheduled' && !dayEnded(day, now) && !isLocked(day);
  const selectedDays = days.filter((day) => checked.has(day.id));

  const saveMutation = useMutation({
    mutationFn: () => {
      if (!schedule) throw new Error('The schedule is not loaded.');
      return saveOpenDaySchedule(
        periodId,
        buildDelta({
          days: schedule.items,
          series: savedSeries,
          edits: editor.edits,
          periodVersion: schedule.period.version,
        }),
      );
    },
    onSuccess: async (saved) => {
      queryClient.setQueryData(scheduleQueryOptions(periodId).queryKey, saved);
      dispatch({ type: 'reset' });
      setSaveError('');
      closePanel();
      notify({ kind: 'success', title: 'Schedule saved', subtitle: 'People with a changed timeslot get a message.' });
      await queryClient.invalidateQueries({ queryKey: openDayKeys.all });
    },
    onError: (error) => setSaveError(scheduleErrorMessage(error)),
  });

  const requestRemoval = (ids: string[]) => {
    const list = days.filter((day) => ids.includes(day.id));
    const saved = list.filter((day) => !day.id.startsWith('new-')).length;
    setRemoval({
      ids,
      label:
        list
          .slice(0, 8)
          .map((day) => shortLabel(day))
          .join(', ') + (list.length > 8 ? ' …' : ''),
      saved,
      assigned: list.reduce(
        (sum, day) =>
          sum +
          day.timeslots.reduce((n, slot) => n + slot.requirements.reduce((m, item) => m + item.assignedCount, 0), 0),
        0,
      ),
      draft: Boolean(draft),
    });
  };
  const confirmRemoval = () => {
    if (!removal) return;
    dispatch({ type: 'remove', ids: removal.ids });
    if (selectedId && removal.ids.includes(selectedId)) closePanel();
    setChecked((current) => new Set([...current].filter((id) => !removal.ids.includes(id))));
    setRemoval(null);
  };
  const duplicate = (day: OpenDay) => {
    if (!period) return;
    const base = valuesOfDay(day);
    const date = addCalendarDays(base.date, 7);
    const values: DayValues = { ...base, date, slots: base.slots.map(({ start, end }) => ({ start, end })) };
    if (date > period.endsOn)
      return notify({ kind: 'warning', title: 'Not duplicated', subtitle: 'Next week is outside this period.' });
    const clash = findOverlap(days, date, values.slots);
    if (clash)
      return notify({
        kind: 'warning',
        title: 'Not duplicated',
        subtitle: `${longDate(date)} already has an open day from ${timeRange(clash.startsAt, clash.endsAt)}.`,
      });
    const key = `new-${++keyCounter.current}`;
    dispatch({ type: 'addDay', key, values });
    select(key);
  };
  const cancelRest = (day: OpenDay, series: { id: string; pending: boolean }) => {
    const saved = savedSeries.find((item) => item.id === series.id);
    if (!saved) return;
    const date = dateOf(day.startsAt);
    if (date <= saved.fromDate)
      return notify({
        kind: 'warning',
        title: 'Not possible',
        subtitle: 'This is the first day of the series; cancel it on its own.',
      });
    const values = { ...valuesOfSeries(saved, date), ...(editor.edits.seriesEdits[saved.id] ?? {}) };
    dispatch({
      type: 'editSeries',
      id: saved.id,
      values: { ...values, untilDate: addCalendarDays(date, -1), applyFrom: date },
    });
    closePanel();
  };
  const bulkApply = (patch: BulkPatch) => {
    const result = applyBulk(selectedDays.filter(editable), patch, days);
    dispatch({ type: 'editDays', changes: result.changes });
    const skippedLocked = selectedDays.length - selectedDays.filter(editable).length;
    notify({
      kind: result.skipped || skippedLocked ? 'warning' : 'info',
      title: `${plural(Object.keys(result.changes).length, 'open day')} changed`,
      subtitle:
        result.skipped || skippedLocked
          ? `${result.skipped + skippedLocked} skipped: overlapping times, or changes a series already covers.`
          : 'Save the schedule to apply them.',
    });
  };

  const seriesViewOf = (id: string) => derived?.series.find((item) => item.id === id);
  const seriesFor = (day: OpenDay) => seriesViewOf(day.seriesId ?? day.detachedFromSeriesId ?? '');
  const today = dateOf(now);
  const notifies = !draft;

  const panelContent = (() => {
    if (!period || !derived) return null;
    if (selecting)
      return (
        <BulkPanel
          selected={selectedDays}
          roles={roles}
          draftPeriod={Boolean(draft)}
          notifies={notifies}
          onUnselect={toggleChecked}
          onSelectAll={() => setChecked(new Set(shown.filter(editable).map((day) => day.id)))}
          onClear={() => setChecked(new Set())}
          onApply={bulkApply}
          onRemove={() => requestRemoval(selectedDays.filter(editable).map((day) => day.id))}
          onClose={toggleSelecting}
        />
      );
    if (panel.kind === 'series') {
      const series = seriesViewOf(panel.id);
      if (!series) return null;
      const edited =
        editor.edits.seriesEdits[series.id] ??
        editor.edits.seriesCreates.find((item) => item.key === series.id)?.values;
      const initial: SeriesValues = edited ?? {
        weekday: series.weekday,
        fromDate: series.fromDate,
        untilDate: series.untilDate,
        applyFrom: today > series.fromDate ? today : series.fromDate,
        slots: series.slots,
        supervisorPlaces: series.supervisorPlaces,
        traineePlaces: series.traineePlaces,
        supervisorRoleIds: series.supervisorRoleIds,
        traineeRoleIds: series.traineeRoleIds,
        forcedDates: series.forcedDates,
      };
      return (
        <SeriesForm
          key={series.id}
          series={series}
          initial={initial}
          periodEndsOn={period.endsOn}
          days={days}
          entries={entries}
          roles={roles}
          today={today}
          notifies={notifies}
          onApply={(values) => {
            dispatch({ type: 'editSeries', id: series.id, values });
            setPanel({ kind: 'view' });
          }}
          onCancel={() => setPanel({ kind: 'view' })}
        />
      );
    }
    if (!selected) return null;
    const assigned = selected.timeslots.reduce(
      (sum, slot) => sum + slot.requirements.reduce((n, item) => n + item.assignedCount, 0),
      0,
    );
    if (panel.kind === 'assign') {
      const slot = selected.timeslots.find((item) => item.id === panel.slotId);
      const requirement = slot?.requirements.find((item) => item.id === panel.requirementId);
      if (slot && requirement)
        return (
          <AssignPanel
            day={selected}
            slot={slot}
            requirement={requirement}
            rows={rows}
            busy={actions.busy}
            onBack={() => setPanel({ kind: 'view' })}
            onPick={(person) => {
              actions.assign(selected, slot, requirement, person);
              setPanel({ kind: 'view' });
            }}
          />
        );
    }
    if (panel.kind === 'edit' && editable(selected)) {
      const series = seriesFor(selected);
      return (
        <DayForm
          key={selected.id}
          day={selected}
          initial={
            editor.edits.dayEdits[selected.id] ??
            editor.edits.creates.find((item) => item.key === selected.id)?.values ??
            valuesOfDay(selected)
          }
          period={period}
          otherDays={days}
          entries={entries}
          roles={roles}
          seriesName={selected.seriesId && series ? seriesLabels.get(series.id) : undefined}
          assigned={assigned}
          notifies={notifies}
          onEditSeries={series && !series.pending ? () => setPanel({ kind: 'series', id: series.id }) : undefined}
          onApply={(values) => {
            dispatch({ type: 'editDay', id: selected.id, values });
            setPanel({ kind: 'view' });
          }}
          onCancel={() => setPanel({ kind: 'view' })}
        />
      );
    }
    return (
      <DayPanel
        day={selected}
        period={period}
        ctx={ctx}
        change={changes.get(selected.id)}
        series={seriesFor(selected)}
        roleNames={roleNames}
        busy={actions.busy}
        actions={{
          onClose: closePanel,
          onJoin: actions.join,
          onLeave: (day, slot) => {
            const requirement = slot.requirements.find((item) => item.id === slot.myAssignment?.requirementId);
            if (requirement) actions.leave(day, slot, requirement);
          },
          onRemove: (day, slot, assignment) => {
            const requirement = slot.requirements.find((item) => item.id === assignment.requirementId);
            if (requirement) actions.remove(day, slot, requirement, assignment);
          },
          onAssign: (slot, requirement) => setPanel({ kind: 'assign', slotId: slot.id, requirementId: requirement.id }),
          onEdit: () => setPanel({ kind: 'edit' }),
          onEditSeries: (id) => setPanel({ kind: 'series', id }),
          onRejoin: (day) => dispatch({ type: 'rejoin', id: day.id }),
          onDuplicate: duplicate,
          onCancel: (day) => requestRemoval([day.id]),
          onCancelRest: cancelRest,
        }}
      />
    );
  })();
  const panelOpen = panelContent !== null && (!selecting || docked || bulkSheet);

  if (scheduleQuery.isPending)
    return (
      <PageShell title="Open Days" width="fluid">
        <InlineLoadingState label="Loading the schedule" />
      </PageShell>
    );
  if (scheduleQuery.isError || !schedule || !period || !derived)
    return (
      <PageShell title="Open Days" width="fluid">
        <ErrorState
          title="Unable to load the schedule"
          message="The period may not exist or you may not see it."
          onRetry={() => void scheduleQuery.refetch()}
        />
      </PageShell>
    );

  const status = STATUS_TAG[period.status];
  // Drafts are for the Leitung only, whatever the list contains.
  const visiblePeriods = (periodsQuery.data?.items ?? []).filter((item) => item.status !== 'draft');
  const tiles = glanceTiles({
    days,
    ctx,
    staffing: dashboardQuery.data?.staffing?.semester?.periodId === period.id ? dashboardQuery.data.staffing : null,
    rows: rowsQuery.data?.supervisors ?? null,
  });
  const content =
    view === 'calendar' ? (
      <CalendarView
        days={days}
        matching={matching}
        entries={entries}
        periodStartsOn={period.startsOn}
        periodEndsOn={period.endsOn}
        ctx={ctx}
        showEarlier={showEarlier || activeSection === 'past' || draft === true}
        onToggleEarlier={() => setShowEarlier((value) => !value)}
        selectedId={selectedId}
        selecting={selecting}
        checked={checked}
        changes={changes}
        onOpen={openDay}
        onToggle={toggleChecked}
      />
    ) : (
      <ListView
        days={shown}
        entries={entries}
        periodStartsOn={period.startsOn}
        periodEndsOn={period.endsOn}
        section={activeSection}
        ctx={ctx}
        selectedId={selectedId}
        selecting={selecting}
        checked={checked}
        changes={changes}
        seriesLabels={seriesLabels}
        onOpen={openDay}
        onToggle={toggleChecked}
        onJoin={actions.join}
        joinDisabled={actions.busy}
      />
    );

  return (
    <PageShell
      title={viewer.canManage ? period.name : 'Open Days'}
      titleAdornment={
        viewer.canManage ? (
          <Tag type={status.type} size="md">
            {status.label}
          </Tag>
        ) : undefined
      }
      breadcrumbs={viewer.canManage ? [{ label: 'Open Days', to: '/open-days' }] : []}
      width="fluid"
      className="open-days-page"
      actions={
        viewer.canManage ? (
          <OverflowMenu size="lg" flipped aria-label="Period actions" iconDescription="Period actions">
            <OverflowMenuItem itemText="Period details" onClick={() => navigate(`/open-days?period=${periodId}`)} />
            <OverflowMenuItem itemText="Breaks" onClick={() => navigate('/open-days?tab=breaks')} />
          </OverflowMenu>
        ) : (
          <Select
            id="od-period-select"
            labelText="Period"
            size="lg"
            value={periodId}
            onChange={(event) => navigate(`/open-days/${event.target.value}`)}
          >
            {(visiblePeriods.some((item) => item.id === periodId) ? visiblePeriods : [period, ...visiblePeriods]).map(
              (item) => (
                <SelectItem key={item.id} value={item.id} text={item.name} />
              ),
            )}
          </Select>
        )
      }
      tabs={
        sections.length > 0 && (
          <SectionTabs
            label="Open days"
            sections={sections}
            selected={activeSection}
            onChange={(id) => setSection(id as SectionId)}
          />
        )
      }
    >
      <div className="od-page">
        <div className="od-status">
          {!viewer.canManage && (
            <Tag type={status.type} size="md">
              {status.label}
            </Tag>
          )}
          <span>
            {dayMonth(period.startsOn)} – {dayMonthYear(period.endsOn)}
          </span>
          {period.signUpDeadline && viewer.canSignUp && (
            <span>Sign up for your minimum by {dayMonthYear(period.signUpDeadline)}</span>
          )}
        </div>
        {draft && !viewer.canManage && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Draft"
            subtitle="Only the Leitung sees this period."
          />
        )}
        <GlanceTiles
          tiles={tiles}
          onSection={(id) => setSection(sections.some((item) => item.id === id) ? (id as SectionId) : 'upcoming')}
        />
        <div className="od-split">
          <div className="od-main">
            <ScheduleToolbar
              view={view}
              onView={setView}
              search={search}
              onSearch={setSearch}
              filterDefs={defs}
              filters={filters}
              onFilters={setFilters}
              canManage={viewer.canManage}
              selecting={selecting}
              onSelecting={toggleSelecting}
              selectedCount={checked.size}
              onEditSelected={docked ? null : () => setBulkSheet(true)}
              onAdd={() => setAddOpen(true)}
            />
            {content}
          </div>
          <PanelFrame
            label="Open day details"
            open={panelOpen}
            onClose={() => (selecting ? setBulkSheet(false) : closePanel())}
            placeholder={
              <p>
                {viewer.canSignUp
                  ? 'Pick an open day to see who is there, sign up or leave.'
                  : 'Pick an open day to see what support is planned.'}
              </p>
            }
          >
            {panelContent}
          </PanelFrame>
        </div>
        {viewer.canManage && (
          <SaveBar
            count={count}
            saving={saveMutation.isPending}
            canUndo={editor.previous !== null}
            error={saveError}
            onSave={() => {
              setSaveError('');
              saveMutation.mutate();
            }}
            onDiscard={() => guard.requestDiscard(() => dispatch({ type: 'reset' }))}
            onUndo={() => dispatch({ type: 'undo' })}
          />
        )}
      </div>
      {addOpen && (
        <AddOpenDaysDialog
          period={period}
          days={days}
          entries={entries}
          today={today}
          onClose={() => setAddOpen(false)}
          onAddSeries={(values) => {
            dispatch({ type: 'addSeries', key: `series-${++keyCounter.current}`, values });
            setAddOpen(false);
          }}
          onAddDay={(values) => {
            const key = `new-${++keyCounter.current}`;
            dispatch({ type: 'addDay', key, values });
            setAddOpen(false);
            select(key);
          }}
        />
      )}
      <ConfirmRemove request={removal} onConfirm={confirmRemoval} onClose={() => setRemoval(null)} />
      <UnsavedChangesDialog
        guard={guard}
        message="The open days you changed have not been saved. Leaving now discards those changes."
      />
    </PageShell>
  );
}

const shortLabel = (day: OpenDay) => `${shortDate(dateOf(day.startsAt))} ${clockOf(day.startsAt)}`;
