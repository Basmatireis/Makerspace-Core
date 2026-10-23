import { CheckmarkFilled, InformationFilled, Misuse, WarningFilled } from '@carbon/icons-react';
import type { OpenDay, OpenDayPeriodStatus } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { type OpenDayScheduleDefaults } from '../scheduleDefaults';
import { type WorkingSlot } from '../scheduleState';

export function toWorking(day: OpenDay): WorkingSlot {
  return {
    id: day.id,
    serverId: day.id,
    original: day,
    startsAt: day.startsAt,
    endsAt: day.endsAt,
    internalNote: day.internalNote,
    requirements: day.requirements.map((item) => ({
      kind: item.kind,
      requiredCount: item.requiredCount,
      eligibleRoleIds: item.eligibleRoleIds ?? [],
    })),
  };
}

export function toPreviewOpenDay(slot: WorkingSlot, periodId: string): OpenDay {
  const requirements = slot.requirements.map((requirement) => {
    const original = slot.original?.requirements.find((item) => item.kind === requirement.kind);
    return original
      ? { ...original, requiredCount: requirement.requiredCount, eligibleRoleIds: requirement.eligibleRoleIds }
      : {
          id: `${slot.id}-${requirement.kind}`,
          kind: requirement.kind,
          requiredCount: requirement.requiredCount,
          assignedCount: 0,
          eligibleRoleIds: requirement.eligibleRoleIds,
        };
  });
  if (slot.original)
    return {
      ...slot.original,
      startsAt: slot.startsAt,
      endsAt: slot.endsAt,
      internalNote: slot.internalNote,
      requirements,
    };
  return {
    id: slot.id,
    periodId,
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    internalNote: slot.internalNote,
    status: 'scheduled',
    requirements,
    competencies: [],
    version: 0,
    createdAt: slot.startsAt,
    updatedAt: slot.startsAt,
  };
}

export type LifecycleTarget = 'draft' | 'staffing' | 'published' | 'archived';

export type LifecycleAction = { target: LifecycleTarget; label: string; confirmation: string; danger?: boolean };

export function actionsForStatus(status: OpenDayPeriodStatus): LifecycleAction[] {
  if (status === 'draft') {
    return [
      {
        target: 'staffing',
        label: 'Open for staffing',
        confirmation: 'Staff will be able to view this period and sign up.',
      },
    ];
  }
  if (status === 'staffing') {
    return [
      {
        target: 'draft',
        label: 'Move back to Draft',
        confirmation: 'This period will no longer be visible to staff. Existing assignments will be kept.',
        danger: true,
      },
      {
        target: 'published',
        label: 'Publish',
        confirmation: 'This period will appear in the public calendar. Internal staffing will remain available.',
      },
    ];
  }
  if (status === 'published') {
    return [
      {
        target: 'staffing',
        label: 'Unpublish and return to staffing',
        confirmation:
          'This period will no longer appear in the public calendar. Internal staffing will remain available.',
        danger: true,
      },
      {
        target: 'archived',
        label: 'Archive',
        confirmation: 'This period will become read-only. Existing Open Days and assignments will be kept.',
        danger: true,
      },
    ];
  }
  return [];
}

type BulkEditField<T> = {
  value: T;
  mixed: boolean;
  changed: boolean;
};

export type BulkEditState = {
  slots: WorkingSlot[];
  startTime: BulkEditField<string>;
  endTime: BulkEditField<string>;
  supervisors: BulkEditField<number | ''>;
  trainees: BulkEditField<number | ''>;
  supervisorRoleIds: BulkEditField<string[]>;
  traineeRoleIds: BulkEditField<string[]>;
  internalNote: BulkEditField<string>;
};

export function bulkEditField<T>(values: T[], equals: (left: T, right: T) => boolean = Object.is): BulkEditField<T> {
  const value = values[0];
  return { value, mixed: values.some((item) => !equals(value, item)), changed: false };
}

export function changedBulkEditField<T>(value: T): BulkEditField<T> {
  return { value, mixed: false, changed: true };
}

export function sameStringSet(left: string[], right: string[]) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

export function hasBulkEditChanges(state: BulkEditState) {
  return (
    state.startTime.changed ||
    state.endTime.changed ||
    state.supervisors.changed ||
    state.trainees.changed ||
    state.supervisorRoleIds.changed ||
    state.traineeRoleIds.changed ||
    state.internalNote.changed
  );
}

export function previewRequirementCount(day: OpenDay, kind: string) {
  const item = day.requirements.find((requirement) => requirement.kind === kind);
  return item ? `${item.assignedCount} / ${item.requiredCount}` : '0 / 0';
}

export function scheduleErrorMessage(error: unknown) {
  if (
    error instanceof ApiError &&
    typeof error.data?.details === 'object' &&
    error.data.details !== null &&
    'reason' in error.data.details &&
    typeof error.data.details.reason === 'string'
  )
    return error.data.details.reason;
  return error instanceof Error ? error.message : 'Review the local date and time and try again.';
}

export function createConfigurationError(configuration: OpenDayScheduleDefaults) {
  if (!configuration.startTime || !configuration.endTime) return 'Enter both a start and end time.';
  if (configuration.supervisors > 0 && configuration.supervisorRoleIds.length === 0)
    return 'Choose at least one eligible supervisor role.';
  if (configuration.trainees > 0 && configuration.traineeRoleIds.length === 0)
    return 'Choose at least one eligible trainee role.';
  return null;
}

export function workingRequirementCount(slot: WorkingSlot, kind: 'supervisor' | 'trainee') {
  const required = slot.requirements.find((item) => item.kind === kind)?.requiredCount ?? 0;
  const assigned = slot.original?.requirements.find((item) => item.kind === kind)?.assignedCount ?? 0;
  return `${assigned} / ${required}`;
}

export function removalButtonLabel(slots: WorkingSlot[], periodStatus: OpenDayPeriodStatus) {
  if (slots.length === 1 && !slots[0].serverId) return 'Remove Open Day';
  if (periodStatus === 'draft') return slots.length === 1 ? 'Delete Open Day' : 'Delete selected';
  return slots.length === 1 ? 'Cancel Open Day' : 'Cancel selected';
}

export function removalHeading(slots: WorkingSlot[], periodStatus: OpenDayPeriodStatus) {
  return `${removalButtonLabel(slots, periodStatus)}?`;
}

export function removalConfirmation(slots: WorkingSlot[], periodStatus: OpenDayPeriodStatus) {
  const count = slots.length;
  if (count === 1 && !slots[0].serverId) return 'This unsaved Open Day will be removed from the working schedule.';
  if (periodStatus === 'draft')
    return `${count === 1 ? 'This draft Open Day' : `These ${count} draft Open Days`} will be permanently deleted when you save the schedule.`;
  const unsaved = slots.filter((slot) => !slot.serverId).length;
  const existing = count - unsaved;
  if (!unsaved)
    return `${existing === 1 ? 'This Open Day' : `These ${existing} Open Days`} will be marked as cancelled when you save the schedule. Existing assignments and history will be kept.`;
  if (!existing) return `These ${unsaved} unsaved Open Days will be removed from the working schedule.`;
  return `${existing} existing Open Day${existing === 1 ? '' : 's'} will be cancelled and ${unsaved} unsaved Open Day${unsaved === 1 ? '' : 's'} will be removed when you save the schedule.`;
}

export function workingSlotPresentation(slot: WorkingSlot) {
  if (slot.original?.status === 'cancelled') return { kind: 'cancelled' as const, label: 'Cancelled', Icon: Misuse };
  const assigned = new Map(slot.original?.requirements.map((item) => [item.kind, item.assignedCount]) ?? []);
  const supervisor = slot.requirements.find((item) => item.kind === 'supervisor');
  const trainee = slot.requirements.find((item) => item.kind === 'trainee');
  if (supervisor && supervisor.requiredCount > (assigned.get('supervisor') ?? 0))
    return {
      kind: 'needs-supervisor' as const,
      label: `${supervisor.requiredCount - (assigned.get('supervisor') ?? 0)} supervisor position${supervisor.requiredCount - (assigned.get('supervisor') ?? 0) === 1 ? '' : 's'} open`,
      Icon: WarningFilled,
    };
  if (trainee && trainee.requiredCount > (assigned.get('trainee') ?? 0))
    return {
      kind: 'needs-trainee' as const,
      label: `${trainee.requiredCount - (assigned.get('trainee') ?? 0)} trainee position${trainee.requiredCount - (assigned.get('trainee') ?? 0) === 1 ? '' : 's'} open`,
      Icon: InformationFilled,
    };
  return { kind: 'staffed' as const, label: 'Fully staffed', Icon: CheckmarkFilled };
}

export function scheduleCreate(slot: WorkingSlot) {
  return {
    startsAt: slot.startsAt,
    endsAt: slot.endsAt,
    internalNote: slot.internalNote,
    requirements: slot.requirements,
  };
}

export function changed(slot: WorkingSlot) {
  const original = slot.original;
  return (
    !original ||
    slot.startsAt !== original.startsAt ||
    slot.endsAt !== original.endsAt ||
    (slot.internalNote ?? null) !== (original.internalNote ?? null) ||
    JSON.stringify(slot.requirements) !==
      JSON.stringify(
        original.requirements.map((item) => ({
          kind: item.kind,
          requiredCount: item.requiredCount,
          eligibleRoleIds: item.eligibleRoleIds ?? [],
        })),
      )
  );
}
