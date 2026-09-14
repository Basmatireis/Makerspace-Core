import { useEffect, useMemo, useReducer, useState } from 'react';
import { Add, Edit, Save, TrashCan, Undo } from '@carbon/icons-react';
import { Button, Checkbox, InlineNotification, Modal, NumberInput, Select, SelectItem, Stack, TextInput, TimePicker, TimePickerSelect } from '@carbon/react';
import { DragDropProvider, useDraggable, useDroppable, type DragEndEvent } from '@dnd-kit/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useBlocker, useParams, useSearchParams } from 'react-router-dom';
import { listOpenDayEligibilityRoles, previewOpenDayRecurrence, saveOpenDaySchedule } from '../../api/generated/open-days/open-days';
import type { CalendarEntry, OpenDay, RecurrenceOccurrence, StaffingRequirementInput } from '../../api/generated/models';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { AcademicBreakManager } from './AcademicBreakManager';
import { CalendarContextMarker } from './CalendarContextMarker';
import { calendarContextQueryOptions, openDayKeys, scheduleQueryOptions } from './queries';
import { scheduleEditorReducer, type WorkingSlot } from './scheduleState';
import { dateInTimeZone, timeInTimeZone, zonedDateTimeToISO } from './dateTime';

function toWorking(day: OpenDay): WorkingSlot {
  return { id: day.id, serverId: day.id, original: day, startsAt: day.startsAt, endsAt: day.endsAt, internalNote: day.internalNote, requirements: day.requirements.map((item) => ({ kind: item.kind, requiredCount: item.requiredCount, eligibleRoleIds: item.eligibleRoleIds ?? [] })) };
}

export function ScheduleEditorPage() {
  const { periodId = '' } = useParams();
  const [params] = useSearchParams();
  const queryClient = useQueryClient();
  const scheduleQuery = useQuery(scheduleQueryOptions(periodId));
  const rolesQuery = useQuery({ queryKey: [...openDayKeys.all, 'eligibility-roles'], queryFn: ({ signal }) => listOpenDayEligibilityRoles({ signal }) });
  const contextQuery = useQuery(calendarContextQueryOptions(periodId));
  const [state, dispatch] = useReducer(scheduleEditorReducer, { slots: [], previous: null, dirty: false });
  const [defaults, setDefaults] = useState({ startTime: '16:00', endTime: '19:00', supervisors: 2, trainees: 1 });
  const [editing, setEditing] = useState<WorkingSlot | null>(null);
  const [publishedConfirmation, setPublishedConfirmation] = useState<WorkingSlot | null>(null);
  const [recurrenceOpen, setRecurrenceOpen] = useState(params.get('recurrence') === '1');
  const [recurrence, setRecurrence] = useState({ weekday: 3, startsOn: '', endsOn: '', everyWeeks: 1, skipPublicHolidays: true, skipAcademicBreaks: true });
  const [preview, setPreview] = useState<RecurrenceOccurrence[]>([]);
  const [selectedOccurrences, setSelectedOccurrences] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (scheduleQuery.data && !state.dirty) {
      dispatch({ type: 'reset', slots: scheduleQuery.data.items.map(toWorking) });
      const editId = params.get('edit');
      if (editId) setEditing(scheduleQuery.data.items.find((item) => item.id === editId) ? toWorking(scheduleQuery.data.items.find((item) => item.id === editId)!) : null);
      setRecurrence((value) => ({ ...value, startsOn: scheduleQuery.data!.period.startsOn, endsOn: scheduleQuery.data!.period.endsOn }));
    }
  }, [scheduleQuery.data, params, state.dirty]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (state.dirty) event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [state.dirty]);
  const blocker = useBlocker(state.dirty);
  const period = scheduleQuery.data?.period;
  const defaultRoleId = rolesQuery.data?.items[0]?.id;
  const makeRequirements = (): StaffingRequirementInput[] => [
    { kind: 'supervisor', requiredCount: defaults.supervisors, eligibleRoleIds: defaults.supervisors > 0 && defaultRoleId ? [defaultRoleId] : [] },
    { kind: 'trainee', requiredCount: defaults.trainees, eligibleRoleIds: defaults.trainees > 0 && defaultRoleId ? [defaultRoleId] : [] },
  ];
  const addDate = (date: string) => {
    const timeZone = scheduleQuery.data!.timeZone;
    const startsAt = zonedDateTimeToISO(date, defaults.startTime, timeZone);
    let endsAt = zonedDateTimeToISO(date, defaults.endTime, timeZone);
    if (new Date(endsAt) <= new Date(startsAt)) endsAt = new Date(new Date(endsAt).getTime() + 86400000).toISOString();
    dispatch({ type: 'add', slot: { id: `local-${crypto.randomUUID()}`, startsAt, endsAt, requirements: makeRequirements() } });
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
      dispatch({ type: 'reset', slots: saved.items.map(toWorking) });
      await queryClient.invalidateQueries({ queryKey: openDayKeys.periods() });
    },
  });
  const previewMutation = useMutation({
    mutationFn: () => previewOpenDayRecurrence(periodId, { ...recurrence, startTime: defaults.startTime, endTime: defaults.endTime }),
    onSuccess: (value) => { setPreview(value.occurrences); setSelectedOccurrences(new Set(value.occurrences.filter((item) => item.disposition === 'create').map((item) => item.startsAt))); },
  });

  const allDates = useMemo(() => period ? datesBetween(period.startsOn, period.endsOn) : [], [period]);
  if (scheduleQuery.isPending || rolesQuery.isPending) return <InlineLoadingState label="Loading schedule editor" />;
  if (scheduleQuery.isError || rolesQuery.isError || !scheduleQuery.data) return <ErrorState title="Unable to load schedule editor" message="Check the connection and your permissions." onRetry={() => { void scheduleQuery.refetch(); void rolesQuery.refetch(); }} />;

  return <DragDropProvider onDragEnd={(event: DragEndEvent) => { if (!event.canceled && event.operation.source?.id && event.operation.target?.id) dispatch({ type: 'move', id: String(event.operation.source.id), date: String(event.operation.target.id), timeZone: scheduleQuery.data.timeZone }); }}>
    <Stack gap={6} className="schedule-editor-page">
      <PageHeader title={`Edit ${scheduleQuery.data.period.name}`} breadcrumbs={[{ label: 'Open Days', to: '/open-days' }, { label: scheduleQuery.data.period.name, to: `/open-days/${periodId}` }]} description={`All changes are saved together · ${scheduleQuery.data.timeZone}`} actions={<><AcademicBreakManager periodId={periodId} periodStartsOn={scheduleQuery.data.period.startsOn} academicBreaks={contextQuery.data?.academicBreaks ?? []} isPending={contextQuery.isPending} isError={contextQuery.isError} /><Button kind="secondary" renderIcon={Undo} disabled={!state.previous} onClick={() => dispatch({ type: 'undo' })}>Undo</Button><Button renderIcon={Save} disabled={!state.dirty || saveMutation.isPending} onClick={() => saveMutation.mutate()}>{saveMutation.isPending ? 'Saving…' : 'Save & close'}</Button></>} />
      {period?.status === 'published' && <InlineNotification kind="warning" lowContrast hideCloseButton title="Published schedule" subtitle="Date changes use the edit form and require confirmation because they affect the public calendar." />}
      {saveMutation.isError && <InlineNotification kind="error" lowContrast title="Schedule was not saved" subtitle="Your working copy is preserved. If the schedule changed elsewhere, reload before retrying." />}
      {contextQuery.isError && <InlineNotification kind="warning" lowContrast hideCloseButton title="Calendar context unavailable" subtitle="Open Days can still be edited, but holidays and academic breaks are temporarily hidden." />}
      <section className="schedule-toolbar" aria-labelledby="slot-defaults-heading"><h2 id="slot-defaults-heading">New slot defaults</h2><TimePicker id="default-start" labelText="Start" value={defaults.startTime} onChange={(event) => setDefaults({ ...defaults, startTime: event.target.value })}><TimePickerSelect id="start-zone" aria-label="Time zone"><option>{scheduleQuery.data.timeZone}</option></TimePickerSelect></TimePicker><TimePicker id="default-end" labelText="End" value={defaults.endTime} onChange={(event) => setDefaults({ ...defaults, endTime: event.target.value })}><TimePickerSelect id="end-zone" aria-label="Time zone"><option>{scheduleQuery.data.timeZone}</option></TimePickerSelect></TimePicker><NumberInput id="default-supervisors" label="Supervisors" min={0} max={100} value={defaults.supervisors} onChange={(_, state) => setDefaults({ ...defaults, supervisors: Number(state.value) })} /><NumberInput id="default-trainees" label="Trainees" min={0} max={100} value={defaults.trainees} onChange={(_, state) => setDefaults({ ...defaults, trainees: Number(state.value) })} /><Button kind="secondary" onClick={() => setRecurrenceOpen(true)}>Recurrence preview</Button></section>
      <p className="schedule-editor-hint">Select a date to add a slot. Drag existing slots to another date in draft or staffing; use Edit as the keyboard-accessible alternative.</p>
      <div className="schedule-date-grid">{allDates.map((date) => <DropDate key={date} date={date} periodStartsOn={scheduleQuery.data.period.startsOn} entries={contextQuery.data?.entries ?? []} slots={state.slots.filter((slot) => dateInTimeZone(slot.startsAt, scheduleQuery.data.timeZone) === date)} published={period?.status === 'published'} onAdd={() => addDate(date)} onEdit={setEditing} />)}</div>
      <Modal open={Boolean(editing)} modalHeading="Edit Open Day" primaryButtonText="Apply" secondaryButtonText="Cancel" onRequestClose={() => setEditing(null)} onRequestSubmit={() => { if (!editing) return; const dateChanged = editing.original && dateInTimeZone(editing.original.startsAt, scheduleQuery.data.timeZone) !== dateInTimeZone(editing.startsAt, scheduleQuery.data.timeZone); if (period?.status === 'published' && dateChanged) setPublishedConfirmation(editing); else dispatch({ type: 'update', slot: editing }); setEditing(null); }}>
        {editing && <SlotForm slot={editing} roles={rolesQuery.data.items} timeZone={scheduleQuery.data.timeZone} onChange={setEditing} onRemove={() => { dispatch({ type: 'remove', id: editing.id }); setEditing(null); }} />}
      </Modal>
      <Modal open={Boolean(publishedConfirmation)} danger modalHeading="Confirm public calendar change" primaryButtonText="Move published Open Day" secondaryButtonText="Keep current date" onRequestClose={() => setPublishedConfirmation(null)} onRequestSubmit={() => { if (publishedConfirmation) dispatch({ type: 'update', slot: publishedConfirmation }); setPublishedConfirmation(null); }}><p>Moving this Open Day changes its public JSON and calendar feed after saving. Subscribers may receive an update.</p></Modal>
      <Modal open={recurrenceOpen} modalHeading="Create recurring Open Days" primaryButtonText={preview.length ? 'Add selected' : 'Preview'} secondaryButtonText="Cancel" onRequestClose={() => { setRecurrenceOpen(false); setPreview([]); }} onRequestSubmit={() => { if (!preview.length) { previewMutation.mutate(); return; } for (const occurrence of preview) if (selectedOccurrences.has(occurrence.startsAt)) dispatch({ type: 'add', slot: { id: `local-${crypto.randomUUID()}`, startsAt: occurrence.startsAt, endsAt: occurrence.endsAt, requirements: makeRequirements() } }); setRecurrenceOpen(false); setPreview([]); }}>
        <Stack gap={4}><Select id="recurrence-weekday" labelText="Weekday" value={recurrence.weekday} onChange={(event) => setRecurrence({ ...recurrence, weekday: Number(event.target.value) })}>{['Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday'].map((name,index) => <SelectItem key={name} value={index+1} text={name} />)}</Select><TextInput id="recurrence-start" type="date" labelText="From" value={recurrence.startsOn} onChange={(event) => setRecurrence({ ...recurrence, startsOn: event.target.value })} /><TextInput id="recurrence-end" type="date" labelText="Until" value={recurrence.endsOn} onChange={(event) => setRecurrence({ ...recurrence, endsOn: event.target.value })} /><NumberInput id="recurrence-weeks" label="Every number of weeks" min={1} max={52} value={recurrence.everyWeeks} onChange={(_, value) => setRecurrence({ ...recurrence, everyWeeks: Number(value.value) })} /><Checkbox id="skip-holidays" labelText="Skip public holidays" checked={recurrence.skipPublicHolidays} onChange={(_, value) => setRecurrence({ ...recurrence, skipPublicHolidays: value.checked })} /><Checkbox id="skip-breaks" labelText="Skip academic breaks" checked={recurrence.skipAcademicBreaks} onChange={(_, value) => setRecurrence({ ...recurrence, skipAcademicBreaks: value.checked })} />{previewMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Preview failed" subtitle="Review the recurrence range and try again." />}{preview.map((item) => <Checkbox key={item.startsAt} id={`occurrence-${item.startsAt}`} labelText={`${dateInTimeZone(item.startsAt, scheduleQuery.data.timeZone)} · ${item.disposition}${item.reason ? ` — ${item.reason}` : ''}`} checked={selectedOccurrences.has(item.startsAt)} onChange={(_, value) => setSelectedOccurrences((current) => { const next = new Set(current); if (value.checked) next.add(item.startsAt); else next.delete(item.startsAt); return next; })} />)}</Stack>
      </Modal>
      <Modal open={blocker.state === 'blocked'} danger modalHeading="Discard unsaved schedule changes?" primaryButtonText="Discard changes" secondaryButtonText="Keep editing" onRequestClose={() => blocker.reset?.()} onRequestSubmit={() => blocker.proceed?.()}><p>Your local schedule changes have not been saved.</p></Modal>
    </Stack>
  </DragDropProvider>;
}

function DropDate({ date, periodStartsOn, entries, slots, published, onAdd, onEdit }: { date: string; periodStartsOn: string; entries: CalendarEntry[]; slots: WorkingSlot[]; published: boolean; onAdd: () => void; onEdit: (slot: WorkingSlot) => void }) {
  const { ref, isDropTarget } = useDroppable({ id: date, disabled: published });
  const contextEntries = entries.filter((entry) => entry.startsOn <= date && entry.endsOn >= date);
  return <section ref={ref} className={`schedule-date${isDropTarget ? ' schedule-date--target' : ''}`}><header><strong>{new Date(`${date}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })}</strong><Button hasIconOnly kind="ghost" size="sm" renderIcon={Add} iconDescription={`Add slot on ${date}`} onClick={onAdd} /></header>{contextEntries.map((entry) => <CalendarContextMarker entry={entry} showBreakLabel={entry.startsOn === date || date === periodStartsOn} key={`${entry.source}-${entry.id ?? entry.name}`} />)}{slots.map((slot) => <DraggableSlot key={slot.id} slot={slot} disabled={published} onEdit={() => onEdit(slot)} />)}</section>;
}
function DraggableSlot({ slot, disabled, onEdit }: { slot: WorkingSlot; disabled: boolean; onEdit: () => void }) {
  const { ref, handleRef, isDragging } = useDraggable({ id: slot.id, disabled });
  return <div ref={ref} className={`working-slot${isDragging ? ' working-slot--dragging' : ''}`}><button ref={handleRef} className="working-slot__handle" type="button" disabled={disabled} aria-label={disabled ? 'Dragging disabled for published period' : 'Drag Open Day to another date'}>{new Date(slot.startsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}–{new Date(slot.endsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</button><Button hasIconOnly kind="ghost" size="sm" renderIcon={Edit} iconDescription="Edit Open Day" onClick={onEdit} /></div>;
}
function SlotForm({ slot, roles, timeZone, onChange, onRemove }: { slot: WorkingSlot; roles: Array<{ id: string; name: string }>; timeZone: string; onChange: (slot: WorkingSlot) => void; onRemove: () => void }) {
  const supervisor = slot.requirements.find((item) => item.kind === 'supervisor')!;
  const trainee = slot.requirements.find((item) => item.kind === 'trainee')!;
  const updateRequirement = (kind: 'supervisor' | 'trainee', patch: Partial<StaffingRequirementInput>) => onChange({ ...slot, requirements: slot.requirements.map((item) => item.kind === kind ? { ...item, ...patch } : item) });
  return <Stack gap={5}><TextInput id="slot-date" type="date" labelText="Date" value={dateInTimeZone(slot.startsAt, timeZone)} onChange={(event) => { const duration = new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime(); const start = zonedDateTimeToISO(event.target.value, timeInTimeZone(slot.startsAt, timeZone), timeZone); onChange({ ...slot, startsAt: start, endsAt: new Date(new Date(start).getTime() + duration).toISOString() }); }} /><TextInput id="slot-start" type="time" labelText="Start time" value={timeInTimeZone(slot.startsAt, timeZone)} onChange={(event) => onChange({ ...slot, startsAt: zonedDateTimeToISO(dateInTimeZone(slot.startsAt, timeZone), event.target.value, timeZone) })} /><TextInput id="slot-end" type="time" labelText="End time" value={timeInTimeZone(slot.endsAt, timeZone)} onChange={(event) => onChange({ ...slot, endsAt: zonedDateTimeToISO(dateInTimeZone(slot.endsAt, timeZone), event.target.value, timeZone) })} /><TextInput id="slot-note" labelText="Internal note" value={slot.internalNote ?? ''} onChange={(event) => onChange({ ...slot, internalNote: event.target.value || null })} /><NumberInput id="slot-supervisor-count" label="Supervisors required" min={0} max={100} value={supervisor.requiredCount} onChange={(_, value) => updateRequirement('supervisor', { requiredCount: Number(value.value) })} /><Select id="slot-supervisor-role" labelText="Eligible supervisor role" value={supervisor.eligibleRoleIds[0] ?? ''} onChange={(event) => updateRequirement('supervisor', { eligibleRoleIds: event.target.value ? [event.target.value] : [] })}><SelectItem value="" text="No role" />{roles.map((role) => <SelectItem key={role.id} value={role.id} text={role.name} />)}</Select><NumberInput id="slot-trainee-count" label="Trainees required" min={0} max={100} value={trainee.requiredCount} onChange={(_, value) => updateRequirement('trainee', { requiredCount: Number(value.value) })} /><Select id="slot-trainee-role" labelText="Eligible trainee role" value={trainee.eligibleRoleIds[0] ?? ''} onChange={(event) => updateRequirement('trainee', { eligibleRoleIds: event.target.value ? [event.target.value] : [] })}><SelectItem value="" text="No role" />{roles.map((role) => <SelectItem key={role.id} value={role.id} text={role.name} />)}</Select><Button kind="danger--ghost" renderIcon={TrashCan} onClick={onRemove}>Remove slot</Button></Stack>;
}
function scheduleCreate(slot: WorkingSlot) { return { startsAt: slot.startsAt, endsAt: slot.endsAt, internalNote: slot.internalNote, requirements: slot.requirements }; }
function changed(slot: WorkingSlot) { const original = slot.original; return !original || slot.startsAt !== original.startsAt || slot.endsAt !== original.endsAt || (slot.internalNote ?? null) !== (original.internalNote ?? null) || JSON.stringify(slot.requirements) !== JSON.stringify(original.requirements.map((item) => ({ kind: item.kind, requiredCount: item.requiredCount, eligibleRoleIds: item.eligibleRoleIds ?? [] }))); }
function datesBetween(start: string, end: string) { const dates: string[] = []; for (let cursor = new Date(`${start}T00:00:00Z`); cursor <= new Date(`${end}T00:00:00Z`); cursor.setUTCDate(cursor.getUTCDate() + 1)) dates.push(cursor.toISOString().slice(0, 10)); return dates; }
