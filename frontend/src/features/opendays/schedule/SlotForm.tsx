import { TrashCan } from '@carbon/icons-react';
import { Button, InlineNotification, NumberInput, Stack, TextInput, TimePicker } from '@carbon/react';
import type { EligibilityRole, StaffingRequirementInput } from '../../../api/generated/models';
import { DateInput } from '../../../app/DateInput';
import { RoleMultiSelect } from '../RoleMultiSelect';
import { type WorkingSlot } from '../scheduleState';
import { dateInTimeZone, timeInTimeZone, validateLocalInstant, zonedDateTimeToISO } from '../dateTime';
import { scheduleErrorMessage } from './scheduleHelpers';

export function SlotForm({
  slot,
  roles,
  timeZone,
  removalLabel,
  onChange,
  onRemove,
  error,
  onError,
}: {
  slot: WorkingSlot;
  roles: EligibilityRole[];
  timeZone: string;
  removalLabel: string;
  onChange: (slot: WorkingSlot) => void;
  onRemove: () => void;
  error: string | null;
  onError: (error: string | null) => void;
}) {
  const supervisor = slot.requirements.find((item) => item.kind === 'supervisor')!;
  const trainee = slot.requirements.find((item) => item.kind === 'trainee')!;
  const updateRequirement = (kind: 'supervisor' | 'trainee', patch: Partial<StaffingRequirementInput>) =>
    onChange({
      ...slot,
      requirements: slot.requirements.map((item) => (item.kind === kind ? { ...item, ...patch } : item)),
    });
  const updateTime = (change: () => WorkingSlot) => {
    try {
      const updated = change();
      validateLocalInstant(updated.startsAt, timeZone);
      validateLocalInstant(updated.endsAt, timeZone);
      onChange(updated);
      onError(null);
    } catch (error) {
      onError(scheduleErrorMessage(error));
    }
  };
  return (
    <Stack gap={5}>
      {error && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Choose a different local time"
          subtitle={error}
        />
      )}
      <DateInput
        id="slot-date"
        labelText="Date"
        value={dateInTimeZone(slot.startsAt, timeZone)}
        onChange={(date) =>
          updateTime(() => {
            const duration = new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime();
            const start = zonedDateTimeToISO(date, timeInTimeZone(slot.startsAt, timeZone), timeZone);
            return { ...slot, startsAt: start, endsAt: new Date(new Date(start).getTime() + duration).toISOString() };
          })
        }
      />
      <TimePicker
        id="slot-start"
        labelText="Start time (24-hour)"
        placeholder="HH:MM"
        value={timeInTimeZone(slot.startsAt, timeZone)}
        onChange={(event) =>
          updateTime(() => ({
            ...slot,
            startsAt: zonedDateTimeToISO(dateInTimeZone(slot.startsAt, timeZone), event.target.value, timeZone),
          }))
        }
      />
      <TimePicker
        id="slot-end"
        labelText="End time (24-hour)"
        placeholder="HH:MM"
        value={timeInTimeZone(slot.endsAt, timeZone)}
        onChange={(event) =>
          updateTime(() => ({
            ...slot,
            endsAt: zonedDateTimeToISO(dateInTimeZone(slot.endsAt, timeZone), event.target.value, timeZone),
          }))
        }
      />
      <TextInput
        id="slot-note"
        labelText="Internal note"
        value={slot.internalNote ?? ''}
        onChange={(event) => onChange({ ...slot, internalNote: event.target.value || null })}
      />
      <NumberInput
        id="slot-supervisor-count"
        label="Supervisors required"
        min={0}
        max={100}
        value={supervisor.requiredCount}
        onChange={(_, value) => updateRequirement('supervisor', { requiredCount: Number(value.value) })}
      />
      <RoleMultiSelect
        id="slot-supervisor-roles"
        titleText="Eligible supervisor roles"
        roles={roles}
        selectedRoleIds={supervisor.eligibleRoleIds}
        onChange={(eligibleRoleIds) => updateRequirement('supervisor', { eligibleRoleIds })}
      />
      <NumberInput
        id="slot-trainee-count"
        label="Trainees required"
        min={0}
        max={100}
        value={trainee.requiredCount}
        onChange={(_, value) => updateRequirement('trainee', { requiredCount: Number(value.value) })}
      />
      <RoleMultiSelect
        id="slot-trainee-roles"
        titleText="Eligible trainee roles"
        roles={roles}
        selectedRoleIds={trainee.eligibleRoleIds}
        onChange={(eligibleRoleIds) => updateRequirement('trainee', { eligibleRoleIds })}
      />
      <Button kind="danger--ghost" renderIcon={TrashCan} onClick={onRemove}>
        {removalLabel}
      </Button>
    </Stack>
  );
}
