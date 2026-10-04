import { useEffect, useReducer, useRef, useState } from 'react';
import { Add, Calendar as CalendarIcon, CheckmarkFilled, Edit, Filter, InformationFilled, List, Misuse, Save, TrashCan, Undo, UserAvatarFilledAlt, View, WarningFilled } from '@carbon/icons-react';
import { Button, Checkbox, DataTable, Dropdown, InlineNotification, Modal, NumberInput, RadioButton, RadioButtonGroup, Select, SelectItem, Stack, Table, TableBatchAction, TableBatchActions, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TableSelectAll, TableSelectRow, TableToolbar, TableToolbarContent, Tag, TextInput, TimePicker } from '@carbon/react';
import { DragDropProvider, useDraggable, useDroppable, type DragEndEvent } from '@dnd-kit/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { archiveOpenDayPeriod, openOpenDayPeriodForStaffing, previewOpenDayRecurrence, publishOpenDayPeriod, returnOpenDayPeriodToDraft, returnOpenDayPeriodToStaffing, saveOpenDaySchedule } from '../../api/generated/open-days/open-days';
import type { CalendarEntry, EligibilityRole, OpenDay, OpenDayPeriodStatus, RecurrenceOccurrence, StaffingRequirementInput } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { DateInput } from '../../app/DateInput';
import { formatDate } from '../../app/dateTime';
import { CalendarEvent } from './CalendarEvent';
import { CalendarLegend } from './CalendarLegend';
import { calendarContextQueryOptions, eligibilityRolesQueryOptions, openDayKeys, scheduleQueryOptions } from './queries';
import { RoleMultiSelect } from './RoleMultiSelect';
import { scheduleDefaultsFromNavigationState, standardOpenDayScheduleDefaults, type OpenDayScheduleDefaults } from './scheduleDefaults';
import { scheduleEditorReducer, type WorkingSlot } from './scheduleState';
import { dateInTimeZone, nextCalendarDate, timeInTimeZone, validateLocalInstant, zonedDateTimeToISO } from './dateTime';
import { longDate, periodRange, registeredPeopleCount, statusTagType, timeRange } from './format';
import { OpenDayDateTimeFilters } from './OpenDayDateTimeFilters';
import { allOpenDayDateTimeFilters, filterOpenDaysByDateTime, type OpenDayDateTimeFilter } from './openDayDateTimeFilter';
import { filterOpenDays, openDayFilterOptions, type OpenDayFilter } from './openDayFilters';
import { OpenDayRegistrationModal } from './OpenDayDetailPage';
import { SemesterCalendar } from './SemesterCalendar';
import { CalendarDayCell, SemesterCalendarGrid, type CalendarGridDay } from './SemesterCalendarGrid';

function toWorking(day: OpenDay): WorkingSlot {
  return { id: day.id, serverId: day.id, original: day, startsAt: day.startsAt, endsAt: day.endsAt, internalNote: day.internalNote, requirements: day.requirements.map((item) => ({ kind: item.kind, requiredCount: item.requiredCount, eligibleRoleIds: item.eligibleRoleIds ?? [] })) };
}

function toPreviewOpenDay(slot: WorkingSlot, periodId: string): OpenDay {
  const requirements = slot.requirements.map((requirement) => {
    const original = slot.original?.requirements.find((item) => item.kind === requirement.kind);
    return original
      ? { ...original, requiredCount: requirement.requiredCount, eligibleRoleIds: requirement.eligibleRoleIds }
      : { id: `${slot.id}-${requirement.kind}`, kind: requirement.kind, requiredCount: requirement.requiredCount, assignedCount: 0, eligibleRoleIds: requirement.eligibleRoleIds };
  });
  if (slot.original) return { ...slot.original, startsAt: slot.startsAt, endsAt: slot.endsAt, internalNote: slot.internalNote, requirements };
  return {
    id: slot.id,
    periodId,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    internalNote: slot.internalNote,
    status: 'scheduled',
    requirements,
    version: 0,
    createdAt: slot.startsAt,
    updatedAt: slot.startsAt,
  };
}

export function ScheduleEditorPage({ canManage = true }: { canManage?: boolean }) {
  const { periodId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const queryClient = useQueryClient();
  const scheduleQuery = useQuery(scheduleQueryOptions(periodId));
  const rolesQuery = useQuery(eligibilityRolesQueryOptions(canManage));
  const contextQuery = useQuery(calendarContextQueryOptions(periodId));
  const [state, dispatch] = useReducer(scheduleEditorReducer, { slots: [], previous: null, dirty: false });
  const incomingDefaults = scheduleDefaultsFromNavigationState(location.state);
  const [defaults, setDefaults] = useState(() => incomingDefaults ?? standardOpenDayScheduleDefaults);
  const defaultsSeeded = useRef(Boolean(incomingDefaults));
  const [createOpen, setCreateOpen] = useState(params.get('recurrence') === '1');
  const [createMode, setCreateMode] = useState<'single' | 'series'>(params.get('recurrence') === '1' ? 'series' : 'single');
  const [createDate, setCreateDate] = useState('');
  const [createDraft, setCreateDraft] = useState<OpenDayScheduleDefaults>(() => incomingDefaults ?? standardOpenDayScheduleDefaults);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkingSlot | null>(null);
  const [bulkEditing, setBulkEditing] = useState<BulkEditState | null>(null);
  const [bulkEditError, setBulkEditError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<WorkingSlot[] | null>(null);
  const [publishedSaveConfirmation, setPublishedSaveConfirmation] = useState(false);
  const [pendingMove, setPendingMove] = useState<{ id: string; date: string; entries: CalendarEntry[] } | null>(null);
  const [pendingTransition, setPendingTransition] = useState<LifecycleAction | null>(null);
  const [view, setView] = useState<'table' | 'calendar'>('calendar');
  const [dateTimeFilter, setDateTimeFilter] = useState<OpenDayDateTimeFilter>(allOpenDayDateTimeFilters);
  const [previewFilter, setPreviewFilter] = useState<OpenDayFilter>('all');
  const [selectedOpenDayId, setSelectedOpenDayId] = useState<string | null>(null);
  const [tableRevision, setTableRevision] = useState(0);
  const [recurrence, setRecurrence] = useState({ weekday: 3, startsOn: '', endsOn: '', everyWeeks: 1, skipPublicHolidays: true, skipAcademicBreaks: true });
  const [preview, setPreview] = useState<RecurrenceOccurrence[]>([]);
  const [selectedOccurrences, setSelectedOccurrences] = useState<Set<string>>(new Set());
  const localSlotSequence = useRef(0);

  useEffect(() => {
    if (scheduleQuery.data && !state.dirty) {
      dispatch({ type: 'reset', slots: scheduleQuery.data.items.map(toWorking) });
      const editId = params.get('edit');
      if (editId) setEditing(scheduleQuery.data.items.find((item) => item.id === editId) ? toWorking(scheduleQuery.data.items.find((item) => item.id === editId)!) : null);
      setRecurrence((value) => ({ ...value, startsOn: scheduleQuery.data!.period.startsOn, endsOn: scheduleQuery.data!.period.endsOn }));
    }
  }, [scheduleQuery.data, params, state.dirty]);

  useEffect(() => {
    if (!rolesQuery.data || defaultsSeeded.current) return;
    defaultsSeeded.current = true;
    const firstRoleId = rolesQuery.data.items[0]?.id;
    if (firstRoleId) {
      setDefaults((value) => ({ ...value, supervisorRoleIds: [firstRoleId], traineeRoleIds: [firstRoleId] }));
      if (createOpen) setCreateDraft((value) => ({ ...value, supervisorRoleIds: [firstRoleId], traineeRoleIds: [firstRoleId] }));
    }
  }, [createOpen, rolesQuery.data]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (state.dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [state.dirty]);
  const blocker = useBlocker(({ currentLocation, nextLocation }) => state.dirty && currentLocation.pathname !== nextLocation.pathname);
  const period = scheduleQuery.data?.period;
  const editingAllowed = canManage && period?.status !== 'archived';
  const editMode = params.get('mode') === 'edit' && editingAllowed;
  const showMode = (mode: 'preview' | 'edit') => {
    const next = new URLSearchParams(params);
    if (mode === 'edit') next.set('mode', 'edit');
    else {
      next.delete('mode');
      next.delete('edit');
      next.delete('recurrence');
    }
    setParams(next, { replace: true });
  };
  useEffect(() => {
    if (!scheduleQuery.data || params.get('mode') !== 'edit') return;
    if (editingAllowed) {
      setSelectedOpenDayId(null);
      return;
    }
    const next = new URLSearchParams(params);
    next.delete('mode');
    next.delete('edit');
    next.delete('recurrence');
    setCreateOpen(false);
    setEditing(null);
    setParams(next, { replace: true });
  }, [editingAllowed, params, scheduleQuery.data, setParams]);
  const makeRequirements = (configuration: OpenDayScheduleDefaults = defaults): StaffingRequirementInput[] => [
    { kind: 'supervisor', requiredCount: configuration.supervisors, eligibleRoleIds: configuration.supervisors > 0 ? configuration.supervisorRoleIds : [] },
    { kind: 'trainee', requiredCount: configuration.trainees, eligibleRoleIds: configuration.trainees > 0 ? configuration.traineeRoleIds : [] },
  ];
  const makeLocalSlot = (startsAt: string, endsAt: string, configuration: OpenDayScheduleDefaults = defaults): WorkingSlot => {
    localSlotSequence.current += 1;
    return { id: `local-${localSlotSequence.current}`, startsAt, endsAt, requirements: makeRequirements(configuration) };
  };
  const beginBulkEdit = (slots: WorkingSlot[]) => {
    const first = slots[0];
    if (!first) return;
    const requirements = (slot: WorkingSlot, kind: 'supervisor' | 'trainee') => slot.requirements.find((item) => item.kind === kind);
    setBulkEditError(null);
    setBulkEditing({
      slots,
      startTime: bulkEditField(slots.map((slot) => timeInTimeZone(slot.startsAt, scheduleQuery.data!.timeZone))),
      endTime: bulkEditField(slots.map((slot) => timeInTimeZone(slot.endsAt, scheduleQuery.data!.timeZone))),
      supervisors: bulkEditField<number | ''>(slots.map((slot) => requirements(slot, 'supervisor')?.requiredCount ?? 0)),
      trainees: bulkEditField<number | ''>(slots.map((slot) => requirements(slot, 'trainee')?.requiredCount ?? 0)),
      supervisorRoleIds: bulkEditField(slots.map((slot) => requirements(slot, 'supervisor')?.eligibleRoleIds ?? []), sameStringSet),
      traineeRoleIds: bulkEditField(slots.map((slot) => requirements(slot, 'trainee')?.eligibleRoleIds ?? []), sameStringSet),
      internalNote: bulkEditField(slots.map((slot) => slot.internalNote ?? '')),
    });
  };
  const applyBulkEdit = () => {
    if (!bulkEditing) return;
    try {
      const timeZone = scheduleQuery.data!.timeZone;
      if (bulkEditing.startTime.changed && !bulkEditing.startTime.value) throw new Error('Enter a start time.');
      if (bulkEditing.endTime.changed && !bulkEditing.endTime.value) throw new Error('Enter an end time.');
      if (bulkEditing.supervisors.changed && bulkEditing.supervisors.value === '') throw new Error('Enter the number of supervisors required.');
      if (bulkEditing.trainees.changed && bulkEditing.trainees.value === '') throw new Error('Enter the number of trainees required.');
      const slots = bulkEditing.slots.map((slot) => {
        const date = dateInTimeZone(slot.startsAt, timeZone);
        const startsAt = bulkEditing.startTime.changed ? zonedDateTimeToISO(date, bulkEditing.startTime.value, timeZone) : slot.startsAt;
        const startTime = timeInTimeZone(startsAt, timeZone);
        const endDate = bulkEditing.endTime.value <= startTime ? nextCalendarDate(date) : date;
        const endsAt = bulkEditing.endTime.changed ? zonedDateTimeToISO(endDate, bulkEditing.endTime.value, timeZone) : slot.endsAt;
        if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) throw new Error('Every Open Day must end after it starts.');
        const requirements = slot.requirements.map((requirement) => {
          if (requirement.kind === 'supervisor') return {
            ...requirement,
            requiredCount: bulkEditing.supervisors.changed ? bulkEditing.supervisors.value as number : requirement.requiredCount,
            eligibleRoleIds: bulkEditing.supervisorRoleIds.changed ? bulkEditing.supervisorRoleIds.value : requirement.eligibleRoleIds,
          };
          if (requirement.kind === 'trainee') return {
            ...requirement,
            requiredCount: bulkEditing.trainees.changed ? bulkEditing.trainees.value as number : requirement.requiredCount,
            eligibleRoleIds: bulkEditing.traineeRoleIds.changed ? bulkEditing.traineeRoleIds.value : requirement.eligibleRoleIds,
          };
          return requirement;
        });
        if (requirements.some((requirement) => requirement.requiredCount > 0 && requirement.eligibleRoleIds.length === 0)) throw new Error('Every enabled position type needs at least one eligible role.');
        return {
          ...slot,
          startsAt,
          endsAt,
          internalNote: bulkEditing.internalNote.changed ? bulkEditing.internalNote.value || null : slot.internalNote,
          requirements,
        };
      });
      dispatch({ type: 'updateMany', slots });
      setBulkEditing(null);
      setBulkEditError(null);
      setTableRevision((value) => value + 1);
    } catch (error) { setBulkEditError(scheduleErrorMessage(error)); }
  };
  const confirmRemoval = () => {
    if (!pendingRemoval) return;
    dispatch({ type: 'removeMany', ids: pendingRemoval.map((slot) => slot.id) });
    setPendingRemoval(null);
    setEditing(null);
    setTableRevision((value) => value + 1);
  };
  const addDate = (date: string, configuration: OpenDayScheduleDefaults = defaults) => {
    try {
      const timeZone = scheduleQuery.data!.timeZone;
      if (date < scheduleQuery.data!.period.startsOn || date > scheduleQuery.data!.period.endsOn) throw new Error('Choose a date within this Open Day period.');
      if ((configuration.supervisors > 0 && configuration.supervisorRoleIds.length === 0) || (configuration.trainees > 0 && configuration.traineeRoleIds.length === 0)) throw new Error('Every enabled position type needs at least one eligible role.');
      const startsAt = zonedDateTimeToISO(date, configuration.startTime, timeZone);
      const endDate = configuration.endTime <= configuration.startTime ? nextCalendarDate(date) : date;
      const endsAt = zonedDateTimeToISO(endDate, configuration.endTime, timeZone);
      dispatch({ type: 'add', slot: makeLocalSlot(startsAt, endsAt, configuration) });
      setTimeError(null);
      return true;
    } catch (error) { setTimeError(scheduleErrorMessage(error)); return false; }
  };
  const openCreate = (mode: 'single' | 'series' = 'single', date = scheduleQuery.data!.period.startsOn) => {
    setCreateMode(mode);
    setCreateDate(date);
    setCreateDraft({ ...defaults });
    setPreview([]);
    setTimeError(null);
    setCreateOpen(true);
  };
  const saveMutation = useMutation({
    mutationFn: async () => {
      const original = new Map(scheduleQuery.data!.items.map((item) => [item.id, item]));
      const currentServerIds = new Set(state.slots.flatMap((slot) => slot.serverId ? [slot.serverId] : []));
      return saveOpenDaySchedule(periodId, {
        expectedPeriodVersion: scheduleQuery.data!.period.version,
        creates: state.slots.filter((slot) => !slot.serverId).map(scheduleCreate),
        updates: state.slots.filter((slot) => slot.serverId && changed(slot)).map((slot) => ({ id: slot.serverId!, expectedVersion: original.get(slot.serverId!)!.version, ...scheduleCreate(slot) })),
        removals: scheduleQuery.data!.items.filter((item) => !currentServerIds.has(item.id)).map((item) => ({ id: item.id, expectedVersion: item.version })),
      });
    },
    onSuccess: async (saved) => {
      setPublishedSaveConfirmation(false);
      queryClient.setQueryData(openDayKeys.schedule(periodId), saved);
      dispatch({ type: 'reset', slots: saved.items.map(toWorking) });
      await queryClient.invalidateQueries({ queryKey: openDayKeys.periods() });
    },
  });
  const lifecycleMutation = useMutation({
    mutationFn: async (target: LifecycleTarget) => {
      const currentPeriod = scheduleQuery.data!.period;
      if (target === 'draft') return returnOpenDayPeriodToDraft(currentPeriod.id, { expectedVersion: currentPeriod.version });
      if (target === 'staffing' && currentPeriod.status === 'published') return returnOpenDayPeriodToStaffing(currentPeriod.id, { expectedVersion: currentPeriod.version });
      if (target === 'staffing') return openOpenDayPeriodForStaffing(currentPeriod.id, { expectedVersion: currentPeriod.version });
      if (target === 'published') return publishOpenDayPeriod(currentPeriod.id, { expectedVersion: currentPeriod.version });
      return archiveOpenDayPeriod(currentPeriod.id, { expectedVersion: currentPeriod.version });
    },
    onSuccess: async (updatedPeriod) => {
      queryClient.setQueryData(openDayKeys.schedule(periodId), (current: typeof scheduleQuery.data) => current ? { ...current, period: updatedPeriod } : current);
      await queryClient.invalidateQueries({ queryKey: openDayKeys.periods() });
      if (updatedPeriod.status === 'archived') showMode('preview');
    },
  });
  const previewMutation = useMutation({
    mutationFn: () => previewOpenDayRecurrence(periodId, { ...recurrence, startTime: createDraft.startTime, endTime: createDraft.endTime }),
    onSuccess: (value) => { setPreview(value.occurrences); setSelectedOccurrences(new Set(value.occurrences.filter((item) => item.disposition === 'create').map((item) => item.startsAt))); },
  });

  if (scheduleQuery.isPending || (canManage && rolesQuery.isPending)) return <InlineLoadingState label="Loading Open Day period" />;
  if (scheduleQuery.isError || (canManage && rolesQuery.isError) || !scheduleQuery.data) return <ErrorState title="Unable to load this period" message="It may no longer be visible, or the connection failed." onRetry={() => { void scheduleQuery.refetch(); if (canManage) void rolesQuery.refetch(); }} />;

  const moveSlot = (id: string, date: string) => dispatch({ type: 'move', id, date, timeZone: scheduleQuery.data.timeZone });
  const lifecycleActions = actionsForStatus(scheduleQuery.data.period.status);
  const previewItems = state.slots.map((slot) => toPreviewOpenDay(slot, periodId));
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.canceled || !event.operation.source?.id || !event.operation.target?.id) return;
    const id = String(event.operation.source.id);
    const date = String(event.operation.target.id);
    const entries = (contextQuery.data?.entries ?? []).filter((entry) => entry.startsOn <= date && entry.endsOn >= date);
    if (entries.length) setPendingMove({ id, date, entries });
    else moveSlot(id, date);
  };

  return <DragDropProvider onDragEnd={handleDragEnd}>
    <PageShell title={scheduleQuery.data.period.name} titleAdornment={<Tag type={statusTagType(scheduleQuery.data.period.status)}>{scheduleQuery.data.period.status}</Tag>} breadcrumbs={[{ label: 'Open Days', to: '/open-days' }, { label: scheduleQuery.data.period.name }]} description={periodRange(scheduleQuery.data.period)} actions={editMode ? lifecycleActions.map((action) => <Button key={action.target} kind={action.danger ? 'danger--tertiary' : 'tertiary'} disabled={state.dirty || lifecycleMutation.isPending || saveMutation.isPending} onClick={() => setPendingTransition(action)}>{action.label}</Button>) : undefined} width="wide" className="open-day-period-page schedule-editor-page">
      {editMode && saveMutation.isError && <InlineNotification kind="error" lowContrast title="Schedule was not saved" subtitle={scheduleErrorMessage(saveMutation.error)} />}
      {editMode && lifecycleMutation.isError && <InlineNotification kind="error" lowContrast title="Status change failed" subtitle="The period may have changed. Reload and try again." onCloseButtonClick={() => lifecycleMutation.reset()} />}
      {editMode && ((!createOpen && timeError) || state.error) && <InlineNotification kind="error" lowContrast hideCloseButton title="Choose a different local time" subtitle={state.error ?? timeError ?? undefined} />}
      {contextQuery.isError && <InlineNotification kind="warning" lowContrast hideCloseButton title="Calendar context unavailable" subtitle="Open Days can still be edited, but holidays and academic breaks are temporarily hidden." />}
      {editMode
        ? <ScheduleWorkingView key={tableRevision} view={view} onView={setView} dateTimeFilter={dateTimeFilter} onDateTimeFilter={setDateTimeFilter} slots={state.slots} startsOn={scheduleQuery.data.period.startsOn} endsOn={scheduleQuery.data.period.endsOn} entries={contextQuery.data?.entries ?? []} timeZone={scheduleQuery.data.timeZone} periodStatus={scheduleQuery.data.period.status} dirty={state.dirty} canUndo={Boolean(state.previous)} lifecyclePending={lifecycleMutation.isPending} savePending={saveMutation.isPending} onUndo={() => dispatch({ type: 'undo' })} onSave={() => period?.status === 'published' ? setPublishedSaveConfirmation(true) : saveMutation.mutate()} onCreate={() => openCreate()} onPreview={() => showMode('preview')} onAdd={(date) => openCreate('single', date)} onEdit={(slot) => { setTimeError(null); setEditing(slot); }} onRemove={(slots) => setPendingRemoval(slots)} onBulkEdit={beginBulkEdit} />
        : <OpenDayPreviewView filter={previewFilter} dateTimeFilter={dateTimeFilter} items={previewItems} timeZone={scheduleQuery.data.timeZone} view={view} canEdit={editingAllowed} period={scheduleQuery.data.period} entries={contextQuery.data?.entries ?? []} onFilter={setPreviewFilter} onDateTimeFilter={setDateTimeFilter} onView={setView} onEdit={() => showMode('edit')} onOpenDay={(day) => { const slot = state.slots.find((item) => item.id === day.id); if (slot?.serverId) setSelectedOpenDayId(slot.serverId); }} />}
      {selectedOpenDayId && <OpenDayRegistrationModal periodId={scheduleQuery.data.period.id} periodStatus={scheduleQuery.data.period.status} openDayId={selectedOpenDayId} onRequestClose={() => setSelectedOpenDayId(null)} />}
      {editMode && <Modal open={Boolean(pendingTransition)} danger={pendingTransition?.danger} modalHeading={pendingTransition?.label ?? 'Change period status'} primaryButtonText={pendingTransition?.label ?? 'Continue'} secondaryButtonText="Cancel" primaryButtonDisabled={lifecycleMutation.isPending} onRequestClose={() => setPendingTransition(null)} onRequestSubmit={() => { if (!pendingTransition) return; const { target } = pendingTransition; setPendingTransition(null); lifecycleMutation.mutate(target); }}>
        <p>{pendingTransition?.confirmation}</p>
      </Modal>}
      {editMode && createOpen && <Modal
        open
        size="sm"
        modalHeading="Create Open Day"
        primaryButtonText={createMode === 'single' ? 'Create' : preview.length ? 'Add selected' : previewMutation.isPending ? 'Previewing…' : 'Preview series'}
        primaryButtonDisabled={previewMutation.isPending || (createMode === 'series' && preview.length > 0 && selectedOccurrences.size === 0)}
        secondaryButtonText="Cancel"
        onRequestClose={() => { setCreateOpen(false); setPreview([]); setTimeError(null); previewMutation.reset(); }}
        onRequestSubmit={() => {
          const configurationError = createConfigurationError(createDraft);
          if (configurationError) { setTimeError(configurationError); return; }
          if (createMode === 'single') {
            if (addDate(createDate, createDraft)) { setDefaults(createDraft); setCreateOpen(false); }
            return;
          }
          if (!preview.length) { previewMutation.mutate(); return; }
          const slots = preview.filter((occurrence) => selectedOccurrences.has(occurrence.startsAt)).map((occurrence) => makeLocalSlot(occurrence.startsAt, occurrence.endsAt, createDraft));
          dispatch({ type: 'addMany', slots });
          setDefaults(createDraft);
          setCreateOpen(false);
          setPreview([]);
        }}
      >
        <Stack gap={5}>
          <RadioButtonGroup legendText="Creation type" name="open-day-create-mode" valueSelected={createMode} onChange={(value) => { setCreateMode(value as 'single' | 'series'); setPreview([]); setTimeError(null); }}>
            <RadioButton id="create-single-open-day" labelText="Single Open Day" value="single" />
            <RadioButton id="create-open-day-series" labelText="Series" value="series" />
          </RadioButtonGroup>
          {timeError && <InlineNotification kind="error" lowContrast hideCloseButton title="Open Day was not created" subtitle={timeError} />}
          {createMode === 'single' ? (
            <DateInput id="create-open-day-date" labelText="Date" value={createDate} onChange={(date) => { setCreateDate(date); setTimeError(null); }} />
          ) : (
            <Stack gap={4}>
              <Select id="recurrence-weekday" labelText="Weekday" value={recurrence.weekday} onChange={(event) => { setRecurrence({ ...recurrence, weekday: Number(event.target.value) }); setPreview([]); }}>{['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map((name,index) => <SelectItem key={name} value={index+1} text={name} />)}</Select>
              <DateInput id="recurrence-start" labelText="From" value={recurrence.startsOn} onChange={(startsOn) => { setRecurrence({ ...recurrence, startsOn }); setPreview([]); }} />
              <DateInput id="recurrence-end" labelText="Until" value={recurrence.endsOn} onChange={(endsOn) => { setRecurrence({ ...recurrence, endsOn }); setPreview([]); }} />
              <NumberInput id="recurrence-weeks" label="Every number of weeks" min={1} max={52} value={recurrence.everyWeeks} onChange={(_, value) => { setRecurrence({ ...recurrence, everyWeeks: Number(value.value) }); setPreview([]); }} />
              <Checkbox id="skip-holidays" labelText="Skip public holidays" checked={recurrence.skipPublicHolidays} onChange={(_, value) => { setRecurrence({ ...recurrence, skipPublicHolidays: value.checked }); setPreview([]); }} />
              <Checkbox id="skip-breaks" labelText="Skip academic breaks" checked={recurrence.skipAcademicBreaks} onChange={(_, value) => { setRecurrence({ ...recurrence, skipAcademicBreaks: value.checked }); setPreview([]); }} />
            </Stack>
          )}
          <div className="open-day-create__times"><TimePicker id="create-start" labelText="Start" value={createDraft.startTime} onChange={(event) => { setCreateDraft({ ...createDraft, startTime: event.target.value }); setPreview([]); setTimeError(null); }} /><TimePicker id="create-end" labelText="End" value={createDraft.endTime} onChange={(event) => { setCreateDraft({ ...createDraft, endTime: event.target.value }); setPreview([]); setTimeError(null); }} /></div>
          <div className="open-day-create__requirements"><NumberInput id="create-supervisors" label="Supervisors" min={0} max={100} value={createDraft.supervisors} onChange={(_, value) => { setCreateDraft({ ...createDraft, supervisors: Number(value.value) }); setPreview([]); setTimeError(null); }} /><NumberInput id="create-trainees" label="Trainees" min={0} max={100} value={createDraft.trainees} onChange={(_, value) => { setCreateDraft({ ...createDraft, trainees: Number(value.value) }); setPreview([]); setTimeError(null); }} /></div>
          <RoleMultiSelect id="create-supervisor-roles" titleText="Eligible supervisor roles" roles={rolesQuery.data?.items ?? []} selectedRoleIds={createDraft.supervisorRoleIds} onChange={(supervisorRoleIds) => { setCreateDraft({ ...createDraft, supervisorRoleIds }); setPreview([]); setTimeError(null); }} />
          <RoleMultiSelect id="create-trainee-roles" titleText="Eligible trainee roles" roles={rolesQuery.data?.items ?? []} selectedRoleIds={createDraft.traineeRoleIds} onChange={(traineeRoleIds) => { setCreateDraft({ ...createDraft, traineeRoleIds }); setPreview([]); setTimeError(null); }} />
          {createMode === 'series' && previewMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Preview failed" subtitle={scheduleErrorMessage(previewMutation.error)} />}
          {createMode === 'series' && preview.map((item) => <Checkbox key={item.startsAt} id={`occurrence-${item.startsAt}`} labelText={`${formatDate(dateInTimeZone(item.startsAt, scheduleQuery.data.timeZone))} · ${item.disposition}${item.reason ? ` — ${item.reason}` : ''}`} checked={selectedOccurrences.has(item.startsAt)} onChange={(_, value) => setSelectedOccurrences((current) => { const next = new Set(current); if (value.checked) next.add(item.startsAt); else next.delete(item.startsAt); return next; })} />)}
        </Stack>
      </Modal>}
      {editMode && <Modal open={Boolean(editing)} modalHeading="Edit Open Day" primaryButtonText="Apply" primaryButtonDisabled={Boolean(timeError)} secondaryButtonText="Cancel" onRequestClose={() => setEditing(null)} onRequestSubmit={() => { if (!editing) return; dispatch({ type: 'update', slot: editing }); setEditing(null); }}>
        {editing && <SlotForm error={timeError} onError={setTimeError} slot={editing} roles={rolesQuery.data?.items ?? []} timeZone={scheduleQuery.data.timeZone} removalLabel={removalButtonLabel([editing], scheduleQuery.data.period.status)} onChange={setEditing} onRemove={() => { setPendingRemoval([editing]); setEditing(null); }} />}
      </Modal>}
      {editMode && bulkEditing && <Modal open size="sm" modalHeading={`Edit ${bulkEditing.slots.length} selected Open Day${bulkEditing.slots.length === 1 ? '' : 's'}`} primaryButtonText="Apply to selected" primaryButtonDisabled={!hasBulkEditChanges(bulkEditing)} secondaryButtonText="Cancel" onRequestClose={() => { setBulkEditing(null); setBulkEditError(null); }} onRequestSubmit={applyBulkEdit}>
        <Stack gap={5}>
          <p>Only values you change are applied.</p>
          {bulkEditError && <InlineNotification kind="error" lowContrast hideCloseButton title="Selected Open Days were not changed" subtitle={bulkEditError} />}
          <div className="bulk-slot-editor__times"><TimePicker id="bulk-start" labelText="Start" placeholder={bulkEditing.startTime.mixed ? 'Mixed' : 'HH:MM'} value={bulkEditing.startTime.mixed ? '' : bulkEditing.startTime.value} onChange={(event) => { setBulkEditError(null); setBulkEditing({ ...bulkEditing, startTime: changedBulkEditField(event.target.value) }); }} /><TimePicker id="bulk-end" labelText="End" placeholder={bulkEditing.endTime.mixed ? 'Mixed' : 'HH:MM'} value={bulkEditing.endTime.mixed ? '' : bulkEditing.endTime.value} onChange={(event) => { setBulkEditError(null); setBulkEditing({ ...bulkEditing, endTime: changedBulkEditField(event.target.value) }); }} /></div>
          <div className="bulk-slot-editor__requirements"><NumberInput id="bulk-supervisors" label="Supervisors required" min={0} max={100} allowEmpty placeholder={bulkEditing.supervisors.mixed ? 'Mixed' : undefined} value={bulkEditing.supervisors.mixed ? '' : bulkEditing.supervisors.value} onChange={(_, value) => { setBulkEditError(null); setBulkEditing({ ...bulkEditing, supervisors: changedBulkEditField(value.value === '' ? '' : Number(value.value)) }); }} /><NumberInput id="bulk-trainees" label="Trainees required" min={0} max={100} allowEmpty placeholder={bulkEditing.trainees.mixed ? 'Mixed' : undefined} value={bulkEditing.trainees.mixed ? '' : bulkEditing.trainees.value} onChange={(_, value) => { setBulkEditError(null); setBulkEditing({ ...bulkEditing, trainees: changedBulkEditField(value.value === '' ? '' : Number(value.value)) }); }} /></div>
          <RoleMultiSelect id="bulk-supervisor-roles" titleText="Eligible supervisor roles" roles={rolesQuery.data?.items ?? []} selectedRoleIds={bulkEditing.supervisorRoleIds.mixed ? [] : bulkEditing.supervisorRoleIds.value} label={bulkEditing.supervisorRoleIds.mixed ? 'Mixed' : 'Choose roles'} onChange={(supervisorRoleIds) => { setBulkEditError(null); setBulkEditing({ ...bulkEditing, supervisorRoleIds: changedBulkEditField(supervisorRoleIds) }); }} />
          <RoleMultiSelect id="bulk-trainee-roles" titleText="Eligible trainee roles" roles={rolesQuery.data?.items ?? []} selectedRoleIds={bulkEditing.traineeRoleIds.mixed ? [] : bulkEditing.traineeRoleIds.value} label={bulkEditing.traineeRoleIds.mixed ? 'Mixed' : 'Choose roles'} onChange={(traineeRoleIds) => { setBulkEditError(null); setBulkEditing({ ...bulkEditing, traineeRoleIds: changedBulkEditField(traineeRoleIds) }); }} />
          <TextInput id="bulk-note" labelText="Internal note" placeholder={bulkEditing.internalNote.mixed ? 'Mixed' : undefined} value={bulkEditing.internalNote.mixed ? '' : bulkEditing.internalNote.value} onChange={(event) => { setBulkEditError(null); setBulkEditing({ ...bulkEditing, internalNote: changedBulkEditField(event.target.value) }); }} />
        </Stack>
      </Modal>}
      {editMode && pendingRemoval && <Modal open danger modalHeading={removalHeading(pendingRemoval, scheduleQuery.data.period.status)} primaryButtonText={removalButtonLabel(pendingRemoval, scheduleQuery.data.period.status)} secondaryButtonText={`Keep Open Day${pendingRemoval.length === 1 ? '' : 's'}`} onRequestClose={() => setPendingRemoval(null)} onRequestSubmit={confirmRemoval}>
        <p>{removalConfirmation(pendingRemoval, scheduleQuery.data.period.status)}</p>
      </Modal>}
      {editMode && <Modal open={publishedSaveConfirmation} danger modalHeading="Save changes to published schedule?" primaryButtonText="Save published schedule" secondaryButtonText="Keep editing" primaryButtonDisabled={saveMutation.isPending} onRequestClose={() => setPublishedSaveConfirmation(false)} onRequestSubmit={() => saveMutation.mutate()}><p>These changes update the public calendar and calendar feed. Subscribers may receive an update.</p></Modal>}
      {editMode && <Modal open={Boolean(pendingMove)} modalHeading="Move onto calendar context?" primaryButtonText="Move Open Day" secondaryButtonText="Keep current date" onRequestClose={() => setPendingMove(null)} onRequestSubmit={() => { if (pendingMove) moveSlot(pendingMove.id, pendingMove.date); setPendingMove(null); }}><p>{pendingMove ? `${pendingMove.date} is marked as ${pendingMove.entries.map((entry) => entry.name).join(', ')}. This does not prevent scheduling.` : ''}</p></Modal>}
      <Modal open={blocker.state === 'blocked'} danger modalHeading="Discard unsaved schedule changes?" primaryButtonText="Discard changes" secondaryButtonText="Keep editing" onRequestClose={() => blocker.reset?.()} onRequestSubmit={() => blocker.proceed?.()}><p>Your local schedule changes have not been saved.</p></Modal>
    </PageShell>
  </DragDropProvider>;
}

type LifecycleTarget = 'draft' | 'staffing' | 'published' | 'archived';
type LifecycleAction = { target: LifecycleTarget; label: string; confirmation: string; danger?: boolean };

function actionsForStatus(status: OpenDayPeriodStatus): LifecycleAction[] {
  if (status === 'draft') {
    return [{ target: 'staffing', label: 'Open for staffing', confirmation: 'Staff will be able to view this period and sign up.' }];
  }
  if (status === 'staffing') {
    return [
      { target: 'draft', label: 'Move back to Draft', confirmation: 'This period will no longer be visible to staff. Existing assignments will be kept.', danger: true },
      { target: 'published', label: 'Publish', confirmation: 'This period will appear in the public calendar. Internal staffing will remain available.' },
    ];
  }
  if (status === 'published') {
    return [
      { target: 'staffing', label: 'Unpublish and return to staffing', confirmation: 'This period will no longer appear in the public calendar. Internal staffing will remain available.', danger: true },
      { target: 'archived', label: 'Archive', confirmation: 'This period will become read-only. Existing Open Days and assignments will be kept.', danger: true },
    ];
  }
  return [];
}

type BulkEditField<T> = {
  value: T;
  mixed: boolean;
  changed: boolean;
};

type BulkEditState = {
  slots: WorkingSlot[];
  startTime: BulkEditField<string>;
  endTime: BulkEditField<string>;
  supervisors: BulkEditField<number | ''>;
  trainees: BulkEditField<number | ''>;
  supervisorRoleIds: BulkEditField<string[]>;
  traineeRoleIds: BulkEditField<string[]>;
  internalNote: BulkEditField<string>;
};

function bulkEditField<T>(values: T[], equals: (left: T, right: T) => boolean = Object.is): BulkEditField<T> {
  const value = values[0];
  return { value, mixed: values.some((item) => !equals(value, item)), changed: false };
}

function changedBulkEditField<T>(value: T): BulkEditField<T> {
  return { value, mixed: false, changed: true };
}

function sameStringSet(left: string[], right: string[]) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function hasBulkEditChanges(state: BulkEditState) {
  return state.startTime.changed || state.endTime.changed || state.supervisors.changed || state.trainees.changed || state.supervisorRoleIds.changed || state.traineeRoleIds.changed || state.internalNote.changed;
}

function OpenDayPreviewView({ filter, dateTimeFilter, items, timeZone, view, canEdit, period, entries, onFilter, onDateTimeFilter, onView, onEdit, onOpenDay }: {
  filter: OpenDayFilter;
  dateTimeFilter: OpenDayDateTimeFilter;
  items: OpenDay[];
  timeZone: string;
  view: 'table' | 'calendar';
  canEdit: boolean;
  period: { startsOn: string; endsOn: string };
  entries: CalendarEntry[];
  onFilter: (filter: OpenDayFilter) => void;
  onDateTimeFilter: (filter: OpenDayDateTimeFilter) => void;
  onView: (view: 'table' | 'calendar') => void;
  onEdit: () => void;
  onOpenDay: (day: OpenDay) => void;
}) {
  const visibleItems = filterOpenDaysByDateTime(filterOpenDays(items, filter), dateTimeFilter, timeZone);
  const visibleItemsById = new Map(visibleItems.map((day) => [day.id, day]));
  const rows = visibleItems.map((day) => ({
    id: day.id,
    date: dateInTimeZone(day.startsAt, timeZone),
    time: timeInTimeZone(day.startsAt, timeZone),
    supervisors: previewRequirementCount(day, 'supervisor'),
    trainees: previewRequirementCount(day, 'trainee'),
    assignment: day.myAssignment ? (day.requirements.find((item) => item.id === day.myAssignment?.requirementId)?.kind ?? 'Assigned') : '—',
  }));
  const headers = [
    { key: 'date', header: 'Date' },
    { key: 'time', header: 'Time' },
    { key: 'supervisors', header: 'Supervisors' },
    { key: 'trainees', header: 'Trainees' },
    { key: 'assignment', header: 'My assignment' },
  ];

  return <DataTable rows={rows} headers={headers} isSortable>
    {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => (
      <TableContainer className="open-days-view-container">
        <OpenDayPreviewToolbar filter={filter} dateTimeFilter={dateTimeFilter} items={items} timeZone={timeZone} view={view} canEdit={canEdit} onFilter={onFilter} onDateTimeFilter={onDateTimeFilter} onView={onView} onEdit={onEdit} />
        {view === 'calendar' ? (
          <div className="open-days-view-content open-days-view-content--calendar">
            <SemesterCalendar startsOn={period.startsOn} endsOn={period.endsOn} days={visibleItems} entries={entries} timeZone={timeZone} onOpenDay={onOpenDay} />
          </div>
        ) : (
          <div className="responsive-table open-days-view-content">
            <Table {...getTableProps()}>
              <TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header, isSortable: header.key === 'date' || header.key === 'time' })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead>
              <TableBody>{tableRows.map((row) => {
                const day = visibleItemsById.get(row.id);
                return <TableRow {...getRowProps({ row })} key={row.id} onClick={() => { if (day) onOpenDay(day); }}>{row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'date' && day ? longDate(day.startsAt, timeZone) : cell.info.header === 'time' && day ? timeRange(day, timeZone) : String(cell.value)}</TableCell>)}</TableRow>;
              })}</TableBody>
            </Table>
          </div>
        )}
      </TableContainer>
    )}
  </DataTable>;
}

function OpenDayPreviewToolbar({ filter, dateTimeFilter, items, timeZone, view, canEdit, onFilter, onDateTimeFilter, onView, onEdit }: {
  filter: OpenDayFilter;
  dateTimeFilter: OpenDayDateTimeFilter;
  items: Array<{ startsAt: string }>;
  timeZone: string;
  view: 'table' | 'calendar';
  canEdit: boolean;
  onFilter: (filter: OpenDayFilter) => void;
  onDateTimeFilter: (filter: OpenDayDateTimeFilter) => void;
  onView: (view: 'table' | 'calendar') => void;
  onEdit: () => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  return <>
    <TableToolbar aria-label="Open Days tools" className="open-days-view-toolbar">
      <TableToolbarContent>
        <div className="open-days-view-toolbar__actions">
          <Button hasIconOnly kind="ghost" size="md" renderIcon={Filter} iconDescription="Filter" aria-expanded={filtersOpen} aria-controls="open-days-filters" onClick={() => setFiltersOpen((open) => !open)} />
          {canEdit && <Button hasIconOnly kind="secondary" size="md" renderIcon={Edit} iconDescription="Edit" onClick={onEdit} />}
          <Button hasIconOnly kind="ghost" size="md" renderIcon={view === 'calendar' ? List : CalendarIcon} iconDescription={view === 'calendar' ? 'Table view' : 'Calendar view'} onClick={() => onView(view === 'calendar' ? 'table' : 'calendar')} />
        </div>
      </TableToolbarContent>
    </TableToolbar>
    {filtersOpen && <div id="open-days-filters" className="open-days-filter-panel">
      <div className="open-days-filter-panel__fields">
        <OpenDayDateTimeFilters idPrefix="open-days" items={items} timeZone={timeZone} value={dateTimeFilter} onChange={onDateTimeFilter} />
        <Dropdown id="open-days-availability-filter" className="open-days-view-toolbar__status-filter" titleText="Filter Open Days" hideLabel size="md" label="Choose Open Days" items={openDayFilterOptions} itemToString={(option) => option?.label ?? ''} selectedItem={openDayFilterOptions.find((option) => option.value === filter)} onChange={({ selectedItem }) => onFilter(selectedItem?.value ?? 'all')} />
      </div>
    </div>}
  </>;
}

function previewRequirementCount(day: OpenDay, kind: string) {
  const item = day.requirements.find((requirement) => requirement.kind === kind);
  return item ? `${item.assignedCount} / ${item.requiredCount}` : '0 / 0';
}

function ScheduleWorkingView({ view, onView, dateTimeFilter, onDateTimeFilter, slots, startsOn, endsOn, entries, timeZone, periodStatus, dirty, canUndo, lifecyclePending, savePending, onUndo, onSave, onCreate, onPreview, onAdd, onEdit, onRemove, onBulkEdit }: {
  view: 'table' | 'calendar';
  onView: (view: 'table' | 'calendar') => void;
  dateTimeFilter: OpenDayDateTimeFilter;
  onDateTimeFilter: (filter: OpenDayDateTimeFilter) => void;
  slots: WorkingSlot[];
  startsOn: string;
  endsOn: string;
  entries: CalendarEntry[];
  timeZone: string;
  periodStatus: OpenDayPeriodStatus;
  dirty: boolean;
  canUndo: boolean;
  lifecyclePending: boolean;
  savePending: boolean;
  onUndo: () => void;
  onSave: () => void;
  onCreate: () => void;
  onPreview: () => void;
  onAdd: (date: string) => void;
  onEdit: (slot: WorkingSlot) => void;
  onRemove: (slots: WorkingSlot[]) => void;
  onBulkEdit: (slots: WorkingSlot[]) => void;
}) {
  const [filtersOpen, setFiltersOpen] = useState(false);
  const orderedSlots = [...slots].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const visibleSlots = filterOpenDaysByDateTime(orderedSlots, dateTimeFilter, timeZone);
  const slotsById = new Map(visibleSlots.map((slot) => [slot.id, slot]));
  const rows = visibleSlots.map((slot) => ({
    id: slot.id,
    date: dateInTimeZone(slot.startsAt, timeZone),
    time: timeInTimeZone(slot.startsAt, timeZone),
    supervisors: workingRequirementCount(slot, 'supervisor'),
    trainees: workingRequirementCount(slot, 'trainee'),
    note: slot.internalNote || '—',
    actions: '',
    disabled: slot.original?.status === 'cancelled',
  }));
  const headers = [
    { key: 'date', header: 'Date' },
    { key: 'time', header: 'Time' },
    { key: 'supervisors', header: 'Supervisors' },
    { key: 'trainees', header: 'Trainees' },
    { key: 'note', header: 'Internal note' },
    { key: 'actions', header: 'Actions' },
  ];

  return <DataTable key={view === 'table' ? orderedSlots.map((slot) => slot.id).join('|') : 'calendar'} rows={rows} headers={headers} isSortable>
    {({ rows: tableRows, headers: tableHeaders, selectedRows, getBatchActionProps, getHeaderProps, getRowProps, getSelectionProps, getTableProps }) => {
      const selectedSlots = selectedRows.map((row) => slotsById.get(row.id)).filter((slot): slot is WorkingSlot => Boolean(slot));
      return <TableContainer className="schedule-editor-view-container">
        <TableToolbar aria-label="Schedule editor tools" className="open-days-view-toolbar">
          {view === 'table' && selectedSlots.length > 0 && <TableBatchActions {...getBatchActionProps()}>
            <TableBatchAction renderIcon={Edit} iconDescription="Edit selected Open Days" onClick={() => onBulkEdit(selectedSlots)}>Edit selected</TableBatchAction>
            <TableBatchAction renderIcon={periodStatus === 'draft' ? TrashCan : Misuse} iconDescription={removalButtonLabel(selectedSlots, periodStatus)} onClick={() => onRemove(selectedSlots)}>{removalButtonLabel(selectedSlots, periodStatus)}</TableBatchAction>
          </TableBatchActions>}
          <TableToolbarContent>
            <div className="schedule-editor-toolbar__actions">
              <Button hasIconOnly kind="ghost" size="md" renderIcon={Filter} iconDescription="Filter" aria-expanded={filtersOpen} aria-controls="schedule-editor-filters" onClick={() => setFiltersOpen((open) => !open)} />
              <Button hasIconOnly kind="secondary" size="md" renderIcon={Undo} iconDescription="Undo" disabled={!canUndo} onClick={onUndo} />
              <Button hasIconOnly kind="secondary" size="md" renderIcon={Save} iconDescription={savePending ? 'Saving…' : 'Save'} disabled={!dirty || savePending || lifecyclePending} onClick={onSave} />
              <Button renderIcon={Add} onClick={onCreate}>Create</Button>
              <Button hasIconOnly kind="secondary" size="md" renderIcon={View} iconDescription="Preview" onClick={onPreview} />
              <Button hasIconOnly kind="ghost" size="md" renderIcon={view === 'calendar' ? List : CalendarIcon} iconDescription={view === 'calendar' ? 'Table view' : 'Calendar view'} onClick={() => onView(view === 'calendar' ? 'table' : 'calendar')} />
            </div>
          </TableToolbarContent>
        </TableToolbar>
        {filtersOpen && <div id="schedule-editor-filters" className="open-days-filter-panel"><OpenDayDateTimeFilters idPrefix="schedule-editor" items={slots} timeZone={timeZone} value={dateTimeFilter} onChange={onDateTimeFilter} /></div>}
        {view === 'calendar' ? <div className="open-days-view-content open-days-view-content--calendar">
          <CalendarLegend />
          <SemesterCalendarGrid startsOn={startsOn} endsOn={endsOn} entries={entries} className="semester-calendar--editor" ariaLabel="Schedule planning calendar" renderDay={(day) => <DropDate key={day.date} day={day} slots={visibleSlots.filter((slot) => dateInTimeZone(slot.startsAt, timeZone) === day.date)} timeZone={timeZone} periodStatus={periodStatus} onAdd={() => onAdd(day.date)} onEdit={onEdit} onRemove={(slot) => onRemove([slot])} />} />
        </div> : <div className="responsive-table open-days-view-content schedule-editor-table">
          <Table {...getTableProps()} aria-label="Editable Open Days">
            <TableHead><TableRow><TableSelectAll {...getSelectionProps()} />{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header, isSortable: header.key === 'date' || header.key === 'time' })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead>
            <TableBody>{tableRows.map((row) => {
              const slot = slotsById.get(row.id);
              return <TableRow {...getRowProps({ row })} key={row.id}>
                <TableSelectRow {...getSelectionProps({ row })} />
                {row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'actions' ? (!slot || slot.original?.status === 'cancelled' ? '—' : <div className="table-actions"><Button hasIconOnly kind="ghost" size="sm" renderIcon={Edit} iconDescription={`Edit Open Day on ${dateInTimeZone(slot.startsAt, timeZone)}`} onClick={() => onEdit(slot)} /><Button hasIconOnly kind="danger--ghost" size="sm" renderIcon={periodStatus === 'draft' || !slot.serverId ? TrashCan : Misuse} iconDescription={removalButtonLabel([slot], periodStatus)} onClick={() => onRemove([slot])} /></div>) : cell.info.header === 'date' && slot ? longDate(slot.startsAt, timeZone) : cell.info.header === 'time' && slot ? timeRange(slot, timeZone) : String(cell.value)}</TableCell>)}
              </TableRow>;
            })}</TableBody>
          </Table>
        </div>}
      </TableContainer>;
    }}
  </DataTable>;
}

function DropDate({ day, slots, timeZone, periodStatus, onAdd, onEdit, onRemove }: { day: CalendarGridDay; slots: WorkingSlot[]; timeZone: string; periodStatus: OpenDayPeriodStatus; onAdd: () => void; onEdit: (slot: WorkingSlot) => void; onRemove: (slot: WorkingSlot) => void }) {
  const published = periodStatus === 'published';
  const { ref, isDropTarget } = useDroppable({ id: day.date, disabled: published || !day.withinRange });
  return <CalendarDayCell ref={ref} day={day} className={isDropTarget ? 'calendar-cell--target' : ''} onSelectDate={day.withinRange ? onAdd : undefined}>{slots.map((slot) => <DraggableSlot key={slot.id} slot={slot} timeZone={timeZone} periodStatus={periodStatus} disabled={published || slot.original?.status === 'cancelled'} onEdit={() => onEdit(slot)} onRemove={() => onRemove(slot)} />)}</CalendarDayCell>;
}
function DraggableSlot({ slot, timeZone, periodStatus, disabled, onEdit, onRemove }: { slot: WorkingSlot; timeZone: string; periodStatus: OpenDayPeriodStatus; disabled: boolean; onEdit: () => void; onRemove: () => void }) {
  const { ref, handleRef, isDragging } = useDraggable({ id: slot.id, disabled });
  const presentation = workingSlotPresentation(slot);
  const cancelled = slot.original?.status === 'cancelled';
  const actions = cancelled ? undefined : <><Button hasIconOnly kind="ghost" size="sm" renderIcon={Edit} iconDescription="Edit Open Day" onClick={onEdit} /><Button hasIconOnly kind="danger--ghost" size="sm" renderIcon={periodStatus === 'draft' || !slot.serverId ? TrashCan : Misuse} iconDescription={removalButtonLabel([slot], periodStatus)} onClick={onRemove} /></>;
  return <div ref={ref}><CalendarEvent kind={presentation.kind} timeLabel={`${timeInTimeZone(slot.startsAt, timeZone)}–${timeInTimeZone(slot.endsAt, timeZone)}`} statusLabel={presentation.label} statusIcon={presentation.Icon} assignmentLabel={slot.original?.myAssignment ? 'Your assignment' : undefined} assignmentIcon={UserAvatarFilledAlt} registeredCount={slot.original ? registeredPeopleCount(slot.original) : 0} onActivate={onEdit} mainRef={handleRef} disabled={cancelled} dragging={isDragging} ariaLabel={`${disabled ? 'Edit' : 'Drag or edit'} Open Day ${timeInTimeZone(slot.startsAt, timeZone)} to ${timeInTimeZone(slot.endsAt, timeZone)}`} actions={actions} /></div>;
}
function SlotForm({ slot, roles, timeZone, removalLabel, onChange, onRemove, error, onError }: { slot: WorkingSlot; roles: EligibilityRole[]; timeZone: string; removalLabel: string; onChange: (slot: WorkingSlot) => void; onRemove: () => void; error: string | null; onError: (error: string | null) => void }) {
  const supervisor = slot.requirements.find((item) => item.kind === 'supervisor')!;
  const trainee = slot.requirements.find((item) => item.kind === 'trainee')!;
  const updateRequirement = (kind: 'supervisor' | 'trainee', patch: Partial<StaffingRequirementInput>) => onChange({ ...slot, requirements: slot.requirements.map((item) => item.kind === kind ? { ...item, ...patch } : item) });
  const updateTime = (change: () => WorkingSlot) => {
    try {
      const updated = change();
      validateLocalInstant(updated.startsAt, timeZone);
      validateLocalInstant(updated.endsAt, timeZone);
      onChange(updated);
      onError(null);
    } catch (error) { onError(scheduleErrorMessage(error)); }
  };
  return <Stack gap={5}>
    {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Choose a different local time" subtitle={error} />}
    <DateInput id="slot-date" labelText="Date" value={dateInTimeZone(slot.startsAt, timeZone)} onChange={(date) => updateTime(() => {
      const duration = new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime();
      const start = zonedDateTimeToISO(date, timeInTimeZone(slot.startsAt, timeZone), timeZone);
      return { ...slot, startsAt: start, endsAt: new Date(new Date(start).getTime() + duration).toISOString() };
    })} />
    <TimePicker id="slot-start" labelText="Start time (24-hour)" placeholder="HH:MM" value={timeInTimeZone(slot.startsAt, timeZone)} onChange={(event) => updateTime(() => ({ ...slot, startsAt: zonedDateTimeToISO(dateInTimeZone(slot.startsAt, timeZone), event.target.value, timeZone) }))} />
    <TimePicker id="slot-end" labelText="End time (24-hour)" placeholder="HH:MM" value={timeInTimeZone(slot.endsAt, timeZone)} onChange={(event) => updateTime(() => ({ ...slot, endsAt: zonedDateTimeToISO(dateInTimeZone(slot.endsAt, timeZone), event.target.value, timeZone) }))} />
    <TextInput id="slot-note" labelText="Internal note" value={slot.internalNote ?? ''} onChange={(event) => onChange({ ...slot, internalNote: event.target.value || null })} />
    <NumberInput id="slot-supervisor-count" label="Supervisors required" min={0} max={100} value={supervisor.requiredCount} onChange={(_, value) => updateRequirement('supervisor', { requiredCount: Number(value.value) })} />
    <RoleMultiSelect id="slot-supervisor-roles" titleText="Eligible supervisor roles" roles={roles} selectedRoleIds={supervisor.eligibleRoleIds} onChange={(eligibleRoleIds) => updateRequirement('supervisor', { eligibleRoleIds })} />
    <NumberInput id="slot-trainee-count" label="Trainees required" min={0} max={100} value={trainee.requiredCount} onChange={(_, value) => updateRequirement('trainee', { requiredCount: Number(value.value) })} />
    <RoleMultiSelect id="slot-trainee-roles" titleText="Eligible trainee roles" roles={roles} selectedRoleIds={trainee.eligibleRoleIds} onChange={(eligibleRoleIds) => updateRequirement('trainee', { eligibleRoleIds })} />
    <Button kind="danger--ghost" renderIcon={TrashCan} onClick={onRemove}>{removalLabel}</Button>
  </Stack>;
}

function scheduleErrorMessage(error: unknown) {
  if (error instanceof ApiError && typeof error.data?.details === 'object' && error.data.details !== null && 'reason' in error.data.details && typeof error.data.details.reason === 'string') return error.data.details.reason;
  return error instanceof Error ? error.message : 'Review the local date and time and try again.';
}

function createConfigurationError(configuration: OpenDayScheduleDefaults) {
  if (!configuration.startTime || !configuration.endTime) return 'Enter both a start and end time.';
  if (configuration.supervisors > 0 && configuration.supervisorRoleIds.length === 0) return 'Choose at least one eligible supervisor role.';
  if (configuration.trainees > 0 && configuration.traineeRoleIds.length === 0) return 'Choose at least one eligible trainee role.';
  return null;
}

function workingRequirementCount(slot: WorkingSlot, kind: 'supervisor' | 'trainee') {
  const required = slot.requirements.find((item) => item.kind === kind)?.requiredCount ?? 0;
  const assigned = slot.original?.requirements.find((item) => item.kind === kind)?.assignedCount ?? 0;
  return `${assigned} / ${required}`;
}

function removalButtonLabel(slots: WorkingSlot[], periodStatus: OpenDayPeriodStatus) {
  if (slots.length === 1 && !slots[0].serverId) return 'Remove Open Day';
  if (periodStatus === 'draft') return slots.length === 1 ? 'Delete Open Day' : 'Delete selected';
  return slots.length === 1 ? 'Cancel Open Day' : 'Cancel selected';
}

function removalHeading(slots: WorkingSlot[], periodStatus: OpenDayPeriodStatus) {
  return `${removalButtonLabel(slots, periodStatus)}?`;
}

function removalConfirmation(slots: WorkingSlot[], periodStatus: OpenDayPeriodStatus) {
  const count = slots.length;
  if (count === 1 && !slots[0].serverId) return 'This unsaved Open Day will be removed from the working schedule.';
  if (periodStatus === 'draft') return `${count === 1 ? 'This draft Open Day' : `These ${count} draft Open Days`} will be permanently deleted when you save the schedule.`;
  const unsaved = slots.filter((slot) => !slot.serverId).length;
  const existing = count - unsaved;
  if (!unsaved) return `${existing === 1 ? 'This Open Day' : `These ${existing} Open Days`} will be marked as cancelled when you save the schedule. Existing assignments and history will be kept.`;
  if (!existing) return `These ${unsaved} unsaved Open Days will be removed from the working schedule.`;
  return `${existing} existing Open Day${existing === 1 ? '' : 's'} will be cancelled and ${unsaved} unsaved Open Day${unsaved === 1 ? '' : 's'} will be removed when you save the schedule.`;
}

function workingSlotPresentation(slot: WorkingSlot) {
  if (slot.original?.status === 'cancelled') return { kind: 'cancelled' as const, label: 'Cancelled', Icon: Misuse };
  const assigned = new Map(slot.original?.requirements.map((item) => [item.kind, item.assignedCount]) ?? []);
  const supervisor = slot.requirements.find((item) => item.kind === 'supervisor');
  const trainee = slot.requirements.find((item) => item.kind === 'trainee');
  if (supervisor && supervisor.requiredCount > (assigned.get('supervisor') ?? 0)) return { kind: 'needs-supervisor' as const, label: `${supervisor.requiredCount - (assigned.get('supervisor') ?? 0)} supervisor position${supervisor.requiredCount - (assigned.get('supervisor') ?? 0) === 1 ? '' : 's'} open`, Icon: WarningFilled };
  if (trainee && trainee.requiredCount > (assigned.get('trainee') ?? 0)) return { kind: 'needs-trainee' as const, label: `${trainee.requiredCount - (assigned.get('trainee') ?? 0)} trainee position${trainee.requiredCount - (assigned.get('trainee') ?? 0) === 1 ? '' : 's'} open`, Icon: InformationFilled };
  return { kind: 'staffed' as const, label: 'Fully staffed', Icon: CheckmarkFilled };
}
function scheduleCreate(slot: WorkingSlot) { return { startsAt: slot.startsAt, endsAt: slot.endsAt, internalNote: slot.internalNote, requirements: slot.requirements }; }
function changed(slot: WorkingSlot) { const original = slot.original; return !original || slot.startsAt !== original.startsAt || slot.endsAt !== original.endsAt || (slot.internalNote ?? null) !== (original.internalNote ?? null) || JSON.stringify(slot.requirements) !== JSON.stringify(original.requirements.map((item) => ({ kind: item.kind, requiredCount: item.requiredCount, eligibleRoleIds: item.eligibleRoleIds ?? [] }))); }
