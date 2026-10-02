import { useEffect, useReducer, useRef, useState } from 'react';
import { ArrowLeft, Calendar as CalendarIcon, CheckmarkFilled, Edit, InformationFilled, List, Misuse, Save, Settings, TrashCan, Undo, UserAvatarFilledAlt, WarningFilled } from '@carbon/icons-react';
import { Button, Checkbox, DataTable, InlineNotification, Modal, NumberInput, Select, SelectItem, Stack, Table, TableBatchAction, TableBatchActions, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TableSelectAll, TableSelectRow, TableToolbar, TableToolbarContent, Tag, TextInput, TimePicker } from '@carbon/react';
import { DragDropProvider, useDraggable, useDroppable, type DragEndEvent } from '@dnd-kit/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { archiveOpenDayPeriod, openOpenDayPeriodForStaffing, previewOpenDayRecurrence, publishOpenDayPeriod, returnOpenDayPeriodToDraft, returnOpenDayPeriodToStaffing, saveOpenDaySchedule } from '../../api/generated/open-days/open-days';
import type { CalendarEntry, EligibilityRole, OpenDay, OpenDayPeriodStatus, RecurrenceOccurrence, StaffingRequirementInput } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { AcademicBreakManager } from './AcademicBreakManager';
import { CalendarEvent } from './CalendarEvent';
import { CalendarLegend } from './CalendarLegend';
import { calendarContextQueryOptions, eligibilityRolesQueryOptions, openDayKeys, scheduleQueryOptions } from './queries';
import { RoleMultiSelect } from './RoleMultiSelect';
import { scheduleDefaultsFromNavigationState, standardOpenDayScheduleDefaults, type OpenDayScheduleDefaults } from './scheduleDefaults';
import { scheduleEditorReducer, type WorkingSlot } from './scheduleState';
import { dateInTimeZone, nextCalendarDate, timeInTimeZone, validateLocalInstant, zonedDateTimeToISO } from './dateTime';
import { longDate, registeredPeopleCount, statusTagType, timeRange } from './format';
import { OpenDayDateTimeFilters } from './OpenDayDateTimeFilters';
import { allOpenDayDateTimeFilters, filterOpenDaysByDateTime, type OpenDayDateTimeFilter } from './openDayDateTimeFilter';
import { CalendarDayCell, SemesterCalendarGrid, type CalendarGridDay } from './SemesterCalendarGrid';

function toWorking(day: OpenDay): WorkingSlot {
  return { id: day.id, serverId: day.id, original: day, startsAt: day.startsAt, endsAt: day.endsAt, internalNote: day.internalNote, requirements: day.requirements.map((item) => ({ kind: item.kind, requiredCount: item.requiredCount, eligibleRoleIds: item.eligibleRoleIds ?? [] })) };
}

export function ScheduleEditorPage() {
  const { periodId = '' } = useParams();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scheduleQuery = useQuery(scheduleQueryOptions(periodId));
  const rolesQuery = useQuery(eligibilityRolesQueryOptions());
  const contextQuery = useQuery(calendarContextQueryOptions(periodId));
  const [state, dispatch] = useReducer(scheduleEditorReducer, { slots: [], previous: null, dirty: false });
  const incomingDefaults = scheduleDefaultsFromNavigationState(location.state);
  const [defaults, setDefaults] = useState(() => incomingDefaults ?? standardOpenDayScheduleDefaults);
  const defaultsSeeded = useRef(Boolean(incomingDefaults));
  const [defaultDraft, setDefaultDraft] = useState<OpenDayScheduleDefaults | null>(null);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkingSlot | null>(null);
  const [bulkEditing, setBulkEditing] = useState<BulkEditState | null>(null);
  const [bulkEditError, setBulkEditError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<WorkingSlot[] | null>(null);
  const [publishedConfirmation, setPublishedConfirmation] = useState<WorkingSlot | null>(null);
  const [pendingMove, setPendingMove] = useState<{ id: string; date: string; entries: CalendarEntry[] } | null>(null);
  const [pendingTransition, setPendingTransition] = useState<LifecycleAction | null>(null);
  const [closeAfterSave, setCloseAfterSave] = useState(false);
  const [view, setView] = useState<'table' | 'calendar'>('calendar');
  const [dateTimeFilter, setDateTimeFilter] = useState<OpenDayDateTimeFilter>(allOpenDayDateTimeFilters);
  const [tableRevision, setTableRevision] = useState(0);
  const [recurrenceOpen, setRecurrenceOpen] = useState(params.get('recurrence') === '1');
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
    if (firstRoleId) setDefaults((value) => ({ ...value, supervisorRoleIds: [firstRoleId], traineeRoleIds: [firstRoleId] }));
  }, [rolesQuery.data]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (state.dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [state.dirty]);
  const blocker = useBlocker(state.dirty && !closeAfterSave);
  useEffect(() => {
    if (!closeAfterSave || state.dirty) return;
    setCloseAfterSave(false);
    navigate(`/open-days/${periodId}`);
  }, [closeAfterSave, navigate, periodId, state.dirty]);
  const period = scheduleQuery.data?.period;
  const makeRequirements = (): StaffingRequirementInput[] => [
    { kind: 'supervisor', requiredCount: defaults.supervisors, eligibleRoleIds: defaults.supervisors > 0 ? defaults.supervisorRoleIds : [] },
    { kind: 'trainee', requiredCount: defaults.trainees, eligibleRoleIds: defaults.trainees > 0 ? defaults.traineeRoleIds : [] },
  ];
  const makeLocalSlot = (startsAt: string, endsAt: string): WorkingSlot => {
    localSlotSequence.current += 1;
    return { id: `local-${localSlotSequence.current}`, startsAt, endsAt, requirements: makeRequirements() };
  };
  const beginBulkEdit = (slots: WorkingSlot[]) => {
    const first = slots[0];
    if (!first) return;
    const supervisor = first.requirements.find((item) => item.kind === 'supervisor')!;
    const trainee = first.requirements.find((item) => item.kind === 'trainee')!;
    setBulkEditError(null);
    setBulkEditing({
      slots,
      startTime: timeInTimeZone(first.startsAt, scheduleQuery.data!.timeZone),
      endTime: timeInTimeZone(first.endsAt, scheduleQuery.data!.timeZone),
      supervisors: supervisor.requiredCount,
      trainees: trainee.requiredCount,
      supervisorRoleIds: supervisor.eligibleRoleIds,
      traineeRoleIds: trainee.eligibleRoleIds,
      internalNote: first.internalNote ?? '',
    });
  };
  const applyBulkEdit = () => {
    if (!bulkEditing) return;
    try {
      const timeZone = scheduleQuery.data!.timeZone;
      const slots = bulkEditing.slots.map((slot) => {
        const date = dateInTimeZone(slot.startsAt, timeZone);
        const startsAt = zonedDateTimeToISO(date, bulkEditing.startTime, timeZone);
        const endDate = bulkEditing.endTime <= bulkEditing.startTime ? nextCalendarDate(date) : date;
        const endsAt = zonedDateTimeToISO(endDate, bulkEditing.endTime, timeZone);
        return {
          ...slot,
          startsAt,
          endsAt,
          internalNote: bulkEditing.internalNote || null,
          requirements: [
            { kind: 'supervisor' as const, requiredCount: bulkEditing.supervisors, eligibleRoleIds: bulkEditing.supervisors > 0 ? bulkEditing.supervisorRoleIds : [] },
            { kind: 'trainee' as const, requiredCount: bulkEditing.trainees, eligibleRoleIds: bulkEditing.trainees > 0 ? bulkEditing.traineeRoleIds : [] },
          ],
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
  const addDate = (date: string) => {
    try {
      const timeZone = scheduleQuery.data!.timeZone;
      const startsAt = zonedDateTimeToISO(date, defaults.startTime, timeZone);
      const endDate = defaults.endTime <= defaults.startTime ? nextCalendarDate(date) : date;
      const endsAt = zonedDateTimeToISO(endDate, defaults.endTime, timeZone);
      dispatch({ type: 'add', slot: makeLocalSlot(startsAt, endsAt) });
      setTimeError(null);
    } catch (error) { setTimeError(scheduleErrorMessage(error)); }
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
      queryClient.setQueryData(openDayKeys.schedule(periodId), saved);
      setCloseAfterSave(true);
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
      if (updatedPeriod.status === 'archived') navigate(`/open-days/${periodId}`);
    },
  });
  const previewMutation = useMutation({
    mutationFn: () => previewOpenDayRecurrence(periodId, { ...recurrence, startTime: defaults.startTime, endTime: defaults.endTime }),
    onSuccess: (value) => { setPreview(value.occurrences); setSelectedOccurrences(new Set(value.occurrences.filter((item) => item.disposition === 'create').map((item) => item.startsAt))); },
  });

  if (scheduleQuery.isPending || rolesQuery.isPending) return <InlineLoadingState label="Loading schedule editor" />;
  if (scheduleQuery.isError || rolesQuery.isError || !scheduleQuery.data) return <ErrorState title="Unable to load schedule editor" message="Check the connection and your permissions." onRetry={() => { void scheduleQuery.refetch(); void rolesQuery.refetch(); }} />;

  const moveSlot = (id: string, date: string) => dispatch({ type: 'move', id, date, timeZone: scheduleQuery.data.timeZone });
  const lifecycleActions = actionsForStatus(scheduleQuery.data.period.status);
  const handleDragEnd = (event: DragEndEvent) => {
    if (event.canceled || !event.operation.source?.id || !event.operation.target?.id) return;
    const id = String(event.operation.source.id);
    const date = String(event.operation.target.id);
    const entries = (contextQuery.data?.entries ?? []).filter((entry) => entry.startsOn <= date && entry.endsOn >= date);
    if (entries.length) setPendingMove({ id, date, entries });
    else moveSlot(id, date);
  };

  return <DragDropProvider onDragEnd={handleDragEnd}>
    <Stack gap={6} className="schedule-editor-page">
      <PageHeader title={`Edit ${scheduleQuery.data.period.name}`} breadcrumbs={[{ label: 'Open Days', to: '/open-days' }, { label: scheduleQuery.data.period.name, to: `/open-days/${periodId}` }]} description={`Calendar planning · ${scheduleQuery.data.timeZone}`} actions={<><Button kind="secondary" renderIcon={ArrowLeft} onClick={() => navigate(`/open-days/${periodId}`)}>Back to preview</Button><AcademicBreakManager periodId={periodId} periodStartsOn={scheduleQuery.data.period.startsOn} academicBreaks={contextQuery.data?.academicBreaks ?? []} isPending={contextQuery.isPending} isError={contextQuery.isError} /></>} />
      {period?.status === 'published' && <InlineNotification kind="warning" lowContrast hideCloseButton title="Published schedule" subtitle="Date changes use the edit form and require confirmation because they affect the public calendar." />}
      {saveMutation.isError && <InlineNotification kind="error" lowContrast title="Schedule was not saved" subtitle={scheduleErrorMessage(saveMutation.error)} />}
      {lifecycleMutation.isError && <InlineNotification kind="error" lowContrast title="Status change failed" subtitle="The period may have changed. Reload and try again." onCloseButtonClick={() => lifecycleMutation.reset()} />}
      {(timeError || state.error) && <InlineNotification kind="error" lowContrast hideCloseButton title="Choose a different local time" subtitle={timeError ?? state.error} />}
      {contextQuery.isError && <InlineNotification kind="warning" lowContrast hideCloseButton title="Calendar context unavailable" subtitle="Open Days can still be edited, but holidays and academic breaks are temporarily hidden." />}
      <section className="schedule-toolbar" aria-label="Schedule creation tools"><div className="schedule-toolbar__actions"><Button kind="secondary" renderIcon={Settings} onClick={() => setDefaultDraft({ ...defaults })}>Open Day defaults</Button><Button kind="secondary" onClick={() => setRecurrenceOpen(true)}>Create series</Button></div><Tag type={state.dirty ? 'blue' : 'gray'}>{state.dirty ? 'Unsaved changes' : 'No unsaved changes'}</Tag></section>
      <p className="schedule-editor-hint">Select a date to add a slot. Use the table to select, edit, or delete multiple Open Days at once.</p>
      <ScheduleWorkingView key={tableRevision} view={view} onView={setView} dateTimeFilter={dateTimeFilter} onDateTimeFilter={setDateTimeFilter} slots={state.slots} startsOn={scheduleQuery.data.period.startsOn} endsOn={scheduleQuery.data.period.endsOn} entries={contextQuery.data?.entries ?? []} timeZone={scheduleQuery.data.timeZone} periodStatus={scheduleQuery.data.period.status} lifecycleActions={lifecycleActions} dirty={state.dirty} canUndo={Boolean(state.previous)} lifecyclePending={lifecycleMutation.isPending} savePending={saveMutation.isPending} onTransition={setPendingTransition} onUndo={() => dispatch({ type: 'undo' })} onSave={() => saveMutation.mutate()} onAdd={addDate} onEdit={(slot) => { setTimeError(null); setEditing(slot); }} onRemove={(slots) => setPendingRemoval(slots)} onBulkEdit={beginBulkEdit} />
      <Modal open={Boolean(pendingTransition)} danger={pendingTransition?.danger} modalHeading={pendingTransition?.label ?? 'Change period status'} primaryButtonText={pendingTransition?.label ?? 'Continue'} secondaryButtonText="Cancel" primaryButtonDisabled={lifecycleMutation.isPending} onRequestClose={() => setPendingTransition(null)} onRequestSubmit={() => { if (!pendingTransition) return; const { target } = pendingTransition; setPendingTransition(null); lifecycleMutation.mutate(target); }}>
        <p>{pendingTransition?.confirmation}</p>
      </Modal>
      {defaultDraft && <Modal open size="lg" modalHeading="Open Day defaults" primaryButtonText="Apply defaults" secondaryButtonText="Cancel" onRequestClose={() => setDefaultDraft(null)} onRequestSubmit={() => { setDefaults(defaultDraft); setDefaultDraft(null); }}>
        <Stack gap={5}>
          <p>These settings apply to Open Days added after this point. Times use Europe/Vienna.</p>
          <div className="open-day-defaults__times"><TimePicker id="default-start" labelText="Start" value={defaultDraft.startTime} onChange={(event) => setDefaultDraft({ ...defaultDraft, startTime: event.target.value })} /><TimePicker id="default-end" labelText="End" value={defaultDraft.endTime} onChange={(event) => setDefaultDraft({ ...defaultDraft, endTime: event.target.value })} /></div>
          <div className="open-day-defaults__requirements"><NumberInput id="default-supervisors" label="Supervisors" min={0} max={100} value={defaultDraft.supervisors} onChange={(_, value) => setDefaultDraft({ ...defaultDraft, supervisors: Number(value.value) })} /><NumberInput id="default-trainees" label="Trainees" min={0} max={100} value={defaultDraft.trainees} onChange={(_, value) => setDefaultDraft({ ...defaultDraft, trainees: Number(value.value) })} /></div>
          <RoleMultiSelect id="default-supervisor-roles" titleText="Eligible supervisor roles" roles={rolesQuery.data.items} selectedRoleIds={defaultDraft.supervisorRoleIds} onChange={(supervisorRoleIds) => setDefaultDraft({ ...defaultDraft, supervisorRoleIds })} />
          <RoleMultiSelect id="default-trainee-roles" titleText="Eligible trainee roles" roles={rolesQuery.data.items} selectedRoleIds={defaultDraft.traineeRoleIds} onChange={(traineeRoleIds) => setDefaultDraft({ ...defaultDraft, traineeRoleIds })} />
        </Stack>
      </Modal>}
      <Modal open={Boolean(editing)} modalHeading="Edit Open Day" primaryButtonText="Apply" primaryButtonDisabled={Boolean(timeError)} secondaryButtonText="Cancel" onRequestClose={() => setEditing(null)} onRequestSubmit={() => { if (!editing) return; const dateChanged = editing.original && dateInTimeZone(editing.original.startsAt, scheduleQuery.data.timeZone) !== dateInTimeZone(editing.startsAt, scheduleQuery.data.timeZone); if (period?.status === 'published' && dateChanged) setPublishedConfirmation(editing); else dispatch({ type: 'update', slot: editing }); setEditing(null); }}>
        {editing && <SlotForm error={timeError} onError={setTimeError} slot={editing} roles={rolesQuery.data.items} timeZone={scheduleQuery.data.timeZone} removalLabel={removalButtonLabel([editing], scheduleQuery.data.period.status)} onChange={setEditing} onRemove={() => { setPendingRemoval([editing]); setEditing(null); }} />}
      </Modal>
      {bulkEditing && <Modal open size="lg" danger={period?.status === 'published'} modalHeading={`Edit ${bulkEditing.slots.length} selected Open Day${bulkEditing.slots.length === 1 ? '' : 's'}`} primaryButtonText="Apply to selected" secondaryButtonText="Cancel" onRequestClose={() => { setBulkEditing(null); setBulkEditError(null); }} onRequestSubmit={applyBulkEdit}>
        <Stack gap={5}>
          <p>These values replace the time, staffing requirements, eligible roles, and internal note for every selected Open Day. Each date is preserved.</p>
          {period?.status === 'published' && <InlineNotification kind="warning" lowContrast hideCloseButton title="Published schedule" subtitle="These changes affect the public calendar after you save the schedule." />}
          {bulkEditError && <InlineNotification kind="error" lowContrast hideCloseButton title="Selected Open Days were not changed" subtitle={bulkEditError} />}
          <div className="bulk-slot-editor__times"><TimePicker id="bulk-start" labelText="Start" value={bulkEditing.startTime} onChange={(event) => { setBulkEditError(null); setBulkEditing({ ...bulkEditing, startTime: event.target.value }); }} /><TimePicker id="bulk-end" labelText="End" value={bulkEditing.endTime} onChange={(event) => { setBulkEditError(null); setBulkEditing({ ...bulkEditing, endTime: event.target.value }); }} /></div>
          <div className="bulk-slot-editor__requirements"><NumberInput id="bulk-supervisors" label="Supervisors required" min={0} max={100} value={bulkEditing.supervisors} onChange={(_, value) => setBulkEditing({ ...bulkEditing, supervisors: Number(value.value) })} /><NumberInput id="bulk-trainees" label="Trainees required" min={0} max={100} value={bulkEditing.trainees} onChange={(_, value) => setBulkEditing({ ...bulkEditing, trainees: Number(value.value) })} /></div>
          <RoleMultiSelect id="bulk-supervisor-roles" titleText="Eligible supervisor roles" roles={rolesQuery.data.items} selectedRoleIds={bulkEditing.supervisorRoleIds} onChange={(supervisorRoleIds) => setBulkEditing({ ...bulkEditing, supervisorRoleIds })} />
          <RoleMultiSelect id="bulk-trainee-roles" titleText="Eligible trainee roles" roles={rolesQuery.data.items} selectedRoleIds={bulkEditing.traineeRoleIds} onChange={(traineeRoleIds) => setBulkEditing({ ...bulkEditing, traineeRoleIds })} />
          <TextInput id="bulk-note" labelText="Internal note" value={bulkEditing.internalNote} onChange={(event) => setBulkEditing({ ...bulkEditing, internalNote: event.target.value })} />
        </Stack>
      </Modal>}
      {pendingRemoval && <Modal open danger modalHeading={removalHeading(pendingRemoval, scheduleQuery.data.period.status)} primaryButtonText={removalButtonLabel(pendingRemoval, scheduleQuery.data.period.status)} secondaryButtonText={`Keep Open Day${pendingRemoval.length === 1 ? '' : 's'}`} onRequestClose={() => setPendingRemoval(null)} onRequestSubmit={confirmRemoval}>
        <p>{removalConfirmation(pendingRemoval, scheduleQuery.data.period.status)}</p>
      </Modal>}
      <Modal open={Boolean(publishedConfirmation)} danger modalHeading="Confirm public calendar change" primaryButtonText="Move published Open Day" secondaryButtonText="Keep current date" onRequestClose={() => setPublishedConfirmation(null)} onRequestSubmit={() => { if (publishedConfirmation) dispatch({ type: 'update', slot: publishedConfirmation }); setPublishedConfirmation(null); }}><p>Moving this Open Day changes its public JSON and calendar feed after saving. Subscribers may receive an update.</p></Modal>
      <Modal open={Boolean(pendingMove)} modalHeading="Move onto calendar context?" primaryButtonText="Move Open Day" secondaryButtonText="Keep current date" onRequestClose={() => setPendingMove(null)} onRequestSubmit={() => { if (pendingMove) moveSlot(pendingMove.id, pendingMove.date); setPendingMove(null); }}><p>{pendingMove ? `${pendingMove.date} is marked as ${pendingMove.entries.map((entry) => entry.name).join(', ')}. This does not prevent scheduling.` : ''}</p></Modal>
      <Modal open={recurrenceOpen} modalHeading="Create series" primaryButtonText={preview.length ? 'Add selected' : 'Preview'} secondaryButtonText="Cancel" onRequestClose={() => { setRecurrenceOpen(false); setPreview([]); }} onRequestSubmit={() => { if (!preview.length) { previewMutation.mutate(); return; } const slots = preview.filter((occurrence) => selectedOccurrences.has(occurrence.startsAt)).map((occurrence) => makeLocalSlot(occurrence.startsAt, occurrence.endsAt)); dispatch({ type: 'addMany', slots }); setRecurrenceOpen(false); setPreview([]); }}>
        <Stack gap={4}><Select id="recurrence-weekday" labelText="Weekday" value={recurrence.weekday} onChange={(event) => setRecurrence({ ...recurrence, weekday: Number(event.target.value) })}>{['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map((name,index) => <SelectItem key={name} value={index+1} text={name} />)}</Select><TextInput id="recurrence-start" type="date" labelText="From" value={recurrence.startsOn} onChange={(event) => setRecurrence({ ...recurrence, startsOn: event.target.value })} /><TextInput id="recurrence-end" type="date" labelText="Until" value={recurrence.endsOn} onChange={(event) => setRecurrence({ ...recurrence, endsOn: event.target.value })} /><NumberInput id="recurrence-weeks" label="Every number of weeks" min={1} max={52} value={recurrence.everyWeeks} onChange={(_, value) => setRecurrence({ ...recurrence, everyWeeks: Number(value.value) })} /><Checkbox id="skip-holidays" labelText="Skip public holidays" checked={recurrence.skipPublicHolidays} onChange={(_, value) => setRecurrence({ ...recurrence, skipPublicHolidays: value.checked })} /><Checkbox id="skip-breaks" labelText="Skip academic breaks" checked={recurrence.skipAcademicBreaks} onChange={(_, value) => setRecurrence({ ...recurrence, skipAcademicBreaks: value.checked })} />{previewMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Preview failed" subtitle={scheduleErrorMessage(previewMutation.error)} />}{preview.map((item) => <Checkbox key={item.startsAt} id={`occurrence-${item.startsAt}`} labelText={`${dateInTimeZone(item.startsAt, scheduleQuery.data.timeZone)} · ${item.disposition}${item.reason ? ` — ${item.reason}` : ''}`} checked={selectedOccurrences.has(item.startsAt)} onChange={(_, value) => setSelectedOccurrences((current) => { const next = new Set(current); if (value.checked) next.add(item.startsAt); else next.delete(item.startsAt); return next; })} />)}</Stack>
      </Modal>
      <Modal open={blocker.state === 'blocked'} danger modalHeading="Discard unsaved schedule changes?" primaryButtonText="Discard changes" secondaryButtonText="Keep editing" onRequestClose={() => blocker.reset?.()} onRequestSubmit={() => blocker.proceed?.()}><p>Your local schedule changes have not been saved.</p></Modal>
    </Stack>
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

type BulkEditState = {
  slots: WorkingSlot[];
  startTime: string;
  endTime: string;
  supervisors: number;
  trainees: number;
  supervisorRoleIds: string[];
  traineeRoleIds: string[];
  internalNote: string;
};

function ScheduleWorkingView({ view, onView, dateTimeFilter, onDateTimeFilter, slots, startsOn, endsOn, entries, timeZone, periodStatus, lifecycleActions, dirty, canUndo, lifecyclePending, savePending, onTransition, onUndo, onSave, onAdd, onEdit, onRemove, onBulkEdit }: {
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
  lifecycleActions: LifecycleAction[];
  dirty: boolean;
  canUndo: boolean;
  lifecyclePending: boolean;
  savePending: boolean;
  onTransition: (action: LifecycleAction) => void;
  onUndo: () => void;
  onSave: () => void;
  onAdd: (date: string) => void;
  onEdit: (slot: WorkingSlot) => void;
  onRemove: (slots: WorkingSlot[]) => void;
  onBulkEdit: (slots: WorkingSlot[]) => void;
}) {
  const orderedSlots = [...slots].sort((left, right) => left.startsAt.localeCompare(right.startsAt));
  const visibleSlots = filterOpenDaysByDateTime(orderedSlots, dateTimeFilter, timeZone);
  const slotsById = new Map(visibleSlots.map((slot) => [slot.id, slot]));
  const rows = visibleSlots.map((slot) => ({
    id: slot.id,
    date: dateInTimeZone(slot.startsAt, timeZone),
    time: timeInTimeZone(slot.startsAt, timeZone),
    supervisors: workingRequirementCount(slot, 'supervisor'),
    trainees: workingRequirementCount(slot, 'trainee'),
    status: workingSlotStatus(slot),
    note: slot.internalNote || '—',
    actions: '',
    disabled: slot.original?.status === 'cancelled',
  }));
  const headers = [
    { key: 'date', header: 'Date' },
    { key: 'time', header: 'Time' },
    { key: 'supervisors', header: 'Supervisors' },
    { key: 'trainees', header: 'Trainees' },
    { key: 'status', header: 'Staffing status' },
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
            <div className="open-days-view-toolbar__views" role="group" aria-label="Schedule view">
              <Button hasIconOnly kind={view === 'table' ? 'primary' : 'ghost'} size="md" renderIcon={List} iconDescription="Table view" aria-pressed={view === 'table'} onClick={() => onView('table')} />
              <Button hasIconOnly kind={view === 'calendar' ? 'primary' : 'ghost'} size="md" renderIcon={CalendarIcon} iconDescription="Calendar view" aria-pressed={view === 'calendar'} onClick={() => onView('calendar')} />
            </div>
            <OpenDayDateTimeFilters idPrefix="schedule-editor" items={slots} timeZone={timeZone} value={dateTimeFilter} onChange={onDateTimeFilter} />
            <div className="schedule-editor-toolbar__actions">
              {lifecycleActions.map((action) => <Button key={action.target} kind={action.danger ? 'danger--tertiary' : 'tertiary'} disabled={dirty || lifecyclePending || savePending} onClick={() => onTransition(action)}>{action.label}</Button>)}
              <Button kind="secondary" renderIcon={Undo} disabled={!canUndo} onClick={onUndo}>Undo</Button>
              <Button renderIcon={Save} disabled={!dirty || savePending || lifecyclePending} onClick={onSave}>{savePending ? 'Saving…' : 'Save & close'}</Button>
            </div>
          </TableToolbarContent>
        </TableToolbar>
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
                {row.cells.map((cell) => <TableCell key={cell.id}>{cell.info.header === 'status' ? <Tag type={statusTagType(String(cell.value))}>{String(cell.value)}</Tag> : cell.info.header === 'actions' ? (!slot || slot.original?.status === 'cancelled' ? '—' : <div className="table-actions"><Button hasIconOnly kind="ghost" size="sm" renderIcon={Edit} iconDescription={`Edit Open Day on ${dateInTimeZone(slot.startsAt, timeZone)}`} onClick={() => onEdit(slot)} /><Button hasIconOnly kind="danger--ghost" size="sm" renderIcon={periodStatus === 'draft' || !slot.serverId ? TrashCan : Misuse} iconDescription={removalButtonLabel([slot], periodStatus)} onClick={() => onRemove([slot])} /></div>) : cell.info.header === 'date' && slot ? longDate(slot.startsAt, timeZone) : cell.info.header === 'time' && slot ? timeRange(slot, timeZone) : String(cell.value)}</TableCell>)}
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
    <TextInput id="slot-date" type="date" labelText="Date" value={dateInTimeZone(slot.startsAt, timeZone)} onChange={(event) => updateTime(() => {
      const duration = new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime();
      const start = zonedDateTimeToISO(event.target.value, timeInTimeZone(slot.startsAt, timeZone), timeZone);
      return { ...slot, startsAt: start, endsAt: new Date(new Date(start).getTime() + duration).toISOString() };
    })} />
    <TextInput id="slot-start" type="time" labelText="Start time" value={timeInTimeZone(slot.startsAt, timeZone)} onChange={(event) => updateTime(() => ({ ...slot, startsAt: zonedDateTimeToISO(dateInTimeZone(slot.startsAt, timeZone), event.target.value, timeZone) }))} />
    <TextInput id="slot-end" type="time" labelText="End time" value={timeInTimeZone(slot.endsAt, timeZone)} onChange={(event) => updateTime(() => ({ ...slot, endsAt: zonedDateTimeToISO(dateInTimeZone(slot.endsAt, timeZone), event.target.value, timeZone) }))} />
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

function workingRequirementCount(slot: WorkingSlot, kind: 'supervisor' | 'trainee') {
  const required = slot.requirements.find((item) => item.kind === kind)?.requiredCount ?? 0;
  const assigned = slot.original?.requirements.find((item) => item.kind === kind)?.assignedCount ?? 0;
  return `${assigned} / ${required}`;
}

function workingSlotStatus(slot: WorkingSlot) {
  if (slot.original?.status === 'cancelled') return 'Cancelled';
  const missing = slot.requirements
    .filter((item) => item.requiredCount > (slot.original?.requirements.find((original) => original.kind === item.kind)?.assignedCount ?? 0))
    .map((item) => item.kind);
  return missing.length ? `Needs ${missing.join(' and ')}` : 'Fully staffed';
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
