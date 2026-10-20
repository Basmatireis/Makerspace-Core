import { useLatestCallback } from '../../../app/useLatestCallback';
import { useEffect, useReducer, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import {
  archiveOpenDayPeriod,
  openOpenDayPeriodForStaffing,
  previewOpenDayRecurrence,
  publishOpenDayPeriod,
  returnOpenDayPeriodToDraft,
  returnOpenDayPeriodToStaffing,
  saveOpenDaySchedule,
} from '../../../api/generated/open-days/open-days';
import type { CalendarEntry, RecurrenceOccurrence, StaffingRequirementInput } from '../../../api/generated/models';
import { useUnsavedChanges } from '../../../app/useUnsavedChanges';
import {
  calendarContextQueryOptions,
  eligibilityRolesQueryOptions,
  openDayKeys,
  scheduleQueryOptions,
} from '../queries';
import { standardOpenDayScheduleDefaults, type OpenDayScheduleDefaults } from '../scheduleDefaults';
import { scheduleEditorReducer, type WorkingSlot } from '../scheduleState';
import { dateInTimeZone, nextCalendarDate, timeInTimeZone, zonedDateTimeToISO } from '../dateTime';
import { allOpenDayDateTimeFilters, type OpenDayDateTimeFilter } from '../openDayDateTimeFilter';
import { type OpenDayFilter } from '../openDayFilters';
import { useOpenDaysLayout } from '../useOpenDaysLayout';
import {
  toWorking,
  LifecycleTarget,
  LifecycleAction,
  BulkEditState,
  bulkEditField,
  sameStringSet,
  hasBulkEditChanges,
  scheduleErrorMessage,
  scheduleCreate,
  changed,
} from './scheduleHelpers';

/** Working copy, forms, mutations and handlers of the Open Day schedule editor. */
export function useScheduleEditor({ canManage }: { canManage: boolean }) {
  const { periodId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const scheduleQuery = useQuery(scheduleQueryOptions(periodId));
  const rolesQuery = useQuery(eligibilityRolesQueryOptions(canManage));
  const contextQuery = useQuery(calendarContextQueryOptions(periodId));
  const [state, dispatch] = useReducer(scheduleEditorReducer, { slots: [], previous: null, dirty: false });
  const [defaults, setDefaults] = useState(standardOpenDayScheduleDefaults);
  const defaultsSeeded = useRef(false);
  const [createOpen, setCreateOpen] = useState(params.get('recurrence') === '1');
  const [createMode, setCreateMode] = useState<'single' | 'series'>(
    params.get('recurrence') === '1' ? 'series' : 'single',
  );
  const [createTouched, setCreateTouched] = useState(false);
  const [localDiscard, setLocalDiscard] = useState<'create' | 'edit' | 'bulk' | null>(null);
  const [seriesStep, setSeriesStep] = useState<'inputs' | 'review'>('inputs');
  const [createDate, setCreateDate] = useState('');
  const [createDraft, setCreateDraft] = useState<OpenDayScheduleDefaults>(standardOpenDayScheduleDefaults);
  const [timeError, setTimeError] = useState<string | null>(null);
  const [editing, setEditing] = useState<WorkingSlot | null>(null);
  const [bulkEditing, setBulkEditing] = useState<BulkEditState | null>(null);
  const [bulkEditError, setBulkEditError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<WorkingSlot[] | null>(null);
  const [publishedSaveConfirmation, setPublishedSaveConfirmation] = useState(false);
  const [pendingMove, setPendingMove] = useState<{ id: string; date: string; entries: CalendarEntry[] } | null>(null);
  const [pendingTransition, setPendingTransition] = useState<LifecycleAction | null>(null);
  const { isPhone, hasCoarsePointer } = useOpenDaysLayout();
  const explicitView = params.get('view');
  const view: 'list' | 'calendar' =
    explicitView === 'list' || explicitView === 'calendar' ? explicitView : isPhone ? 'list' : 'calendar';
  const setView = (nextView: 'list' | 'calendar') => {
    const next = new URLSearchParams(params);
    next.set('view', nextView);
    setParams(next);
  };
  const [dateTimeFilter, setDateTimeFilter] = useState<OpenDayDateTimeFilter>(allOpenDayDateTimeFilters);
  const [previewFilter, setPreviewFilter] = useState<OpenDayFilter>('all');
  const [selectedOpenDayId, setSelectedOpenDayId] = useState<string | null>(null);
  const [tableRevision, setTableRevision] = useState(0);
  const [recurrence, setRecurrence] = useState({
    weekday: 3,
    startsOn: '',
    endsOn: '',
    everyWeeks: 1,
    skipPublicHolidays: true,
    skipAcademicBreaks: true,
  });
  const [preview, setPreview] = useState<RecurrenceOccurrence[]>([]);
  const [selectedOccurrences, setSelectedOccurrences] = useState<Set<string>>(new Set());
  const localSlotSequence = useRef(0);
  const workingBaseline = useRef<typeof scheduleQuery.data>(undefined);
  const consumedEditId = useRef<string | null>(null);

  useEffect(() => {
    if (scheduleQuery.data && !state.dirty && !editing && !createTouched && !bulkEditing) {
      workingBaseline.current = scheduleQuery.data;
      dispatch({ type: 'reset', slots: scheduleQuery.data.items.map(toWorking) });
      const editId = params.get('edit');
      if (editId && editId !== consumedEditId.current) {
        consumedEditId.current = editId;
        setEditing(
          (current) =>
            current ??
            (scheduleQuery.data.items.find((item) => item.id === editId)
              ? toWorking(scheduleQuery.data.items.find((item) => item.id === editId)!)
              : null),
        );
      }
      if (!createTouched)
        setRecurrence((value) => ({
          ...value,
          startsOn: scheduleQuery.data!.period.startsOn,
          endsOn: scheduleQuery.data!.period.endsOn,
        }));
    }
  }, [scheduleQuery.data, params, state.dirty, createTouched, editing, bulkEditing]);

  useEffect(() => {
    if (!rolesQuery.data || defaultsSeeded.current) return;
    defaultsSeeded.current = true;
    const firstRoleId = rolesQuery.data.items[0]?.id;
    if (firstRoleId) {
      setDefaults((value) => ({ ...value, supervisorRoleIds: [firstRoleId], traineeRoleIds: [firstRoleId] }));
      if (createOpen)
        setCreateDraft((value) => ({ ...value, supervisorRoleIds: [firstRoleId], traineeRoleIds: [firstRoleId] }));
    }
  }, [createOpen, rolesQuery.data]);

  const editingDirty = Boolean(
    editing && JSON.stringify(editing) !== JSON.stringify(state.slots.find((slot) => slot.id === editing.id)),
  );
  const formsDirty =
    (createOpen && createTouched) || editingDirty || Boolean(bulkEditing && hasBulkEditChanges(bulkEditing));
  const unsavedChanges = useUnsavedChanges({
    isDirty: state.dirty || formsDirty,
    shouldBlockNavigation: (current, next) => current.pathname !== next.pathname || formsDirty,
    onDiscard: () => {
      setCreateOpen(false);
      setEditing(null);
      setBulkEditing(null);
      setLocalDiscard(null);
      if (scheduleQuery.data) {
        workingBaseline.current = scheduleQuery.data;
        dispatch({ type: 'reset', slots: scheduleQuery.data.items.map(toWorking) });
      }
    },
  });
  const closeCreate = () => {
    setCreateOpen(false);
    setPreview([]);
    setTimeError(null);
    setCreateTouched(false);
    setLocalDiscard(null);
    previewMutation.reset();
  };
  const closeEditing = () => {
    setEditing(null);
    setTimeError(null);
    setLocalDiscard(null);
  };
  const closeBulk = () => {
    setBulkEditing(null);
    setBulkEditError(null);
    setLocalDiscard(null);
  };
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
    {
      kind: 'supervisor',
      requiredCount: configuration.supervisors,
      eligibleRoleIds: configuration.supervisors > 0 ? configuration.supervisorRoleIds : [],
    },
    {
      kind: 'trainee',
      requiredCount: configuration.trainees,
      eligibleRoleIds: configuration.trainees > 0 ? configuration.traineeRoleIds : [],
    },
  ];
  const makeLocalSlot = (
    startsAt: string,
    endsAt: string,
    configuration: OpenDayScheduleDefaults = defaults,
  ): WorkingSlot => {
    localSlotSequence.current += 1;
    return {
      id: `local-${localSlotSequence.current}`,
      startsAt,
      endsAt,
      requirements: makeRequirements(configuration),
    };
  };
  const beginBulkEdit = (slots: WorkingSlot[]) => {
    const first = slots[0];
    if (!first) return;
    const requirements = (slot: WorkingSlot, kind: 'supervisor' | 'trainee') =>
      slot.requirements.find((item) => item.kind === kind);
    setBulkEditError(null);
    setBulkEditing({
      slots,
      startTime: bulkEditField(slots.map((slot) => timeInTimeZone(slot.startsAt, scheduleQuery.data!.timeZone))),
      endTime: bulkEditField(slots.map((slot) => timeInTimeZone(slot.endsAt, scheduleQuery.data!.timeZone))),
      supervisors: bulkEditField<number | ''>(
        slots.map((slot) => requirements(slot, 'supervisor')?.requiredCount ?? 0),
      ),
      trainees: bulkEditField<number | ''>(slots.map((slot) => requirements(slot, 'trainee')?.requiredCount ?? 0)),
      supervisorRoleIds: bulkEditField(
        slots.map((slot) => requirements(slot, 'supervisor')?.eligibleRoleIds ?? []),
        sameStringSet,
      ),
      traineeRoleIds: bulkEditField(
        slots.map((slot) => requirements(slot, 'trainee')?.eligibleRoleIds ?? []),
        sameStringSet,
      ),
      internalNote: bulkEditField(slots.map((slot) => slot.internalNote ?? '')),
    });
  };
  const applyBulkEdit = () => {
    if (!bulkEditing) return;
    try {
      const timeZone = scheduleQuery.data!.timeZone;
      if (bulkEditing.startTime.changed && !bulkEditing.startTime.value) throw new Error('Enter a start time.');
      if (bulkEditing.endTime.changed && !bulkEditing.endTime.value) throw new Error('Enter an end time.');
      if (bulkEditing.supervisors.changed && bulkEditing.supervisors.value === '')
        throw new Error('Enter the number of supervisors required.');
      if (bulkEditing.trainees.changed && bulkEditing.trainees.value === '')
        throw new Error('Enter the number of trainees required.');
      const slots = bulkEditing.slots.map((slot) => {
        const date = dateInTimeZone(slot.startsAt, timeZone);
        const startsAt = bulkEditing.startTime.changed
          ? zonedDateTimeToISO(date, bulkEditing.startTime.value, timeZone)
          : slot.startsAt;
        const startTime = timeInTimeZone(startsAt, timeZone);
        const endDate = bulkEditing.endTime.value <= startTime ? nextCalendarDate(date) : date;
        const endsAt = bulkEditing.endTime.changed
          ? zonedDateTimeToISO(endDate, bulkEditing.endTime.value, timeZone)
          : slot.endsAt;
        if (new Date(endsAt).getTime() <= new Date(startsAt).getTime())
          throw new Error('Every Open Day must end after it starts.');
        const requirements = slot.requirements.map((requirement) => {
          if (requirement.kind === 'supervisor')
            return {
              ...requirement,
              requiredCount: bulkEditing.supervisors.changed
                ? (bulkEditing.supervisors.value as number)
                : requirement.requiredCount,
              eligibleRoleIds: bulkEditing.supervisorRoleIds.changed
                ? bulkEditing.supervisorRoleIds.value
                : requirement.eligibleRoleIds,
            };
          if (requirement.kind === 'trainee')
            return {
              ...requirement,
              requiredCount: bulkEditing.trainees.changed
                ? (bulkEditing.trainees.value as number)
                : requirement.requiredCount,
              eligibleRoleIds: bulkEditing.traineeRoleIds.changed
                ? bulkEditing.traineeRoleIds.value
                : requirement.eligibleRoleIds,
            };
          return requirement;
        });
        if (
          requirements.some((requirement) => requirement.requiredCount > 0 && requirement.eligibleRoleIds.length === 0)
        )
          throw new Error('Every enabled position type needs at least one eligible role.');
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
    } catch (error) {
      setBulkEditError(scheduleErrorMessage(error));
    }
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
      if (date < scheduleQuery.data!.period.startsOn || date > scheduleQuery.data!.period.endsOn)
        throw new Error('Choose a date within this Open Day period.');
      if (
        (configuration.supervisors > 0 && configuration.supervisorRoleIds.length === 0) ||
        (configuration.trainees > 0 && configuration.traineeRoleIds.length === 0)
      )
        throw new Error('Every enabled position type needs at least one eligible role.');
      const startsAt = zonedDateTimeToISO(date, configuration.startTime, timeZone);
      const endDate = configuration.endTime <= configuration.startTime ? nextCalendarDate(date) : date;
      const endsAt = zonedDateTimeToISO(endDate, configuration.endTime, timeZone);
      dispatch({ type: 'add', slot: makeLocalSlot(startsAt, endsAt, configuration) });
      setTimeError(null);
      return true;
    } catch (error) {
      setTimeError(scheduleErrorMessage(error));
      return false;
    }
  };
  const openCreate = (mode: 'single' | 'series' = 'single', date = scheduleQuery.data!.period.startsOn) => {
    setCreateTouched(false);
    setSeriesStep('inputs');
    setCreateMode(mode);
    setCreateDate(date);
    setCreateDraft({ ...defaults });
    setPreview([]);
    setTimeError(null);
    setCreateOpen(true);
  };
  const saveMutation = useMutation({
    mutationFn: async () => {
      const baseline = workingBaseline.current ?? scheduleQuery.data!;
      const original = new Map(baseline.items.map((item) => [item.id, item]));
      const currentServerIds = new Set(state.slots.flatMap((slot) => (slot.serverId ? [slot.serverId] : [])));
      return saveOpenDaySchedule(periodId, {
        expectedPeriodVersion: baseline.period.version,
        creates: state.slots.filter((slot) => !slot.serverId).map(scheduleCreate),
        updates: state.slots
          .filter((slot) => slot.serverId && changed(slot))
          .map((slot) => ({
            id: slot.serverId!,
            expectedVersion: original.get(slot.serverId!)!.version,
            ...scheduleCreate(slot),
          })),
        removals: baseline.items
          .filter((item) => !currentServerIds.has(item.id))
          .map((item) => ({ id: item.id, expectedVersion: item.version })),
      });
    },
    onSuccess: async (saved) => {
      workingBaseline.current = saved;
      setPublishedSaveConfirmation(false);
      queryClient.setQueryData(openDayKeys.schedule(periodId), saved);
      dispatch({ type: 'reset', slots: saved.items.map(toWorking) });
      await queryClient.invalidateQueries({ queryKey: openDayKeys.periods() });
    },
  });
  const lifecycleMutation = useMutation({
    mutationFn: async (target: LifecycleTarget) => {
      const currentPeriod = scheduleQuery.data!.period;
      if (target === 'draft')
        return returnOpenDayPeriodToDraft(currentPeriod.id, { expectedVersion: currentPeriod.version });
      if (target === 'staffing' && currentPeriod.status === 'published')
        return returnOpenDayPeriodToStaffing(currentPeriod.id, { expectedVersion: currentPeriod.version });
      if (target === 'staffing')
        return openOpenDayPeriodForStaffing(currentPeriod.id, { expectedVersion: currentPeriod.version });
      if (target === 'published')
        return publishOpenDayPeriod(currentPeriod.id, { expectedVersion: currentPeriod.version });
      return archiveOpenDayPeriod(currentPeriod.id, { expectedVersion: currentPeriod.version });
    },
    onSuccess: async (updatedPeriod) => {
      setPendingTransition(null);
      queryClient.setQueryData(openDayKeys.schedule(periodId), (current: typeof scheduleQuery.data) =>
        current ? { ...current, period: updatedPeriod } : current,
      );
      await queryClient.invalidateQueries({ queryKey: openDayKeys.periods() });
      if (updatedPeriod.status === 'archived') showMode('preview');
    },
  });
  const previewMutation = useMutation({
    mutationFn: () =>
      previewOpenDayRecurrence(periodId, {
        ...recurrence,
        startTime: createDraft.startTime,
        endTime: createDraft.endTime,
      }),
    onSuccess: (value) => {
      setSeriesStep('review');
      setPreview(value.occurrences);
      setSelectedOccurrences(
        new Set(value.occurrences.filter((item) => item.disposition === 'create').map((item) => item.startsAt)),
      );
    },
  });

  const requestCreateClose = useLatestCallback(() => {
    if (previewMutation.isPending) return;
    if (localDiscard) setLocalDiscard(null);
    else if (createTouched) setLocalDiscard('create');
    else closeCreate();
  });

  const requestEditClose = useLatestCallback(() => {
    if (localDiscard) setLocalDiscard(null);
    else if (editingDirty) setLocalDiscard('edit');
    else closeEditing();
  });

  const requestBulkClose = useLatestCallback(() => {
    if (localDiscard) setLocalDiscard(null);
    else if (bulkEditing && hasBulkEditChanges(bulkEditing)) setLocalDiscard('bulk');
    else closeBulk();
  });

  const requestPublishedSaveClose = useLatestCallback(() => {
    if (!saveMutation.isPending) setPublishedSaveConfirmation(false);
  });

  const requestLifecycleClose = useLatestCallback(() => {
    if (!lifecycleMutation.isPending) setPendingTransition(null);
  });

  return {
    periodId,
    scheduleQuery,
    rolesQuery,
    contextQuery,
    state,
    dispatch,
    setDefaults,
    createOpen,
    setCreateOpen,
    createMode,
    setCreateMode,
    setCreateTouched,
    localDiscard,
    seriesStep,
    setSeriesStep,
    createDate,
    setCreateDate,
    createDraft,
    setCreateDraft,
    timeError,
    setTimeError,
    editing,
    setEditing,
    bulkEditing,
    setBulkEditing,
    bulkEditError,
    setBulkEditError,
    pendingRemoval,
    setPendingRemoval,
    publishedSaveConfirmation,
    setPublishedSaveConfirmation,
    pendingMove,
    setPendingMove,
    pendingTransition,
    setPendingTransition,
    isPhone,
    hasCoarsePointer,
    view,
    setView,
    dateTimeFilter,
    setDateTimeFilter,
    previewFilter,
    setPreviewFilter,
    selectedOpenDayId,
    setSelectedOpenDayId,
    tableRevision,
    recurrence,
    setRecurrence,
    preview,
    setPreview,
    selectedOccurrences,
    setSelectedOccurrences,
    unsavedChanges,
    closeCreate,
    closeEditing,
    closeBulk,
    period,
    editingAllowed,
    editMode,
    showMode,
    makeLocalSlot,
    beginBulkEdit,
    applyBulkEdit,
    confirmRemoval,
    addDate,
    openCreate,
    saveMutation,
    lifecycleMutation,
    previewMutation,
    requestCreateClose,
    requestEditClose,
    requestBulkClose,
    requestPublishedSaveClose,
    requestLifecycleClose,
  };
}

export type ScheduleEditor = ReturnType<typeof useScheduleEditor>;
