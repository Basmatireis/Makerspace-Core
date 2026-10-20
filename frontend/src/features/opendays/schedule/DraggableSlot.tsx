import { Edit, Misuse, TrashCan, UserAvatarFilledAlt } from '@carbon/icons-react';
import { Button } from '@carbon/react';
import { useDraggable, useDroppable } from '@dnd-kit/react';
import type { OpenDayPeriodStatus } from '../../../api/generated/models';
import { CalendarEvent } from '../CalendarEvent';
import { type WorkingSlot } from '../scheduleState';
import { timeInTimeZone } from '../dateTime';
import { registeredPeopleCount } from '../format';
import { CalendarDayCell, type CalendarGridDay } from '../SemesterCalendarGrid';
import { removalButtonLabel, workingSlotPresentation } from './scheduleHelpers';

export function DropDate({
  day,
  slots,
  timeZone,
  periodStatus,
  disableDrag,
  onAdd,
  onEdit,
  onRemove,
}: {
  day: CalendarGridDay;
  slots: WorkingSlot[];
  timeZone: string;
  periodStatus: OpenDayPeriodStatus;
  disableDrag: boolean;
  onAdd: () => void;
  onEdit: (slot: WorkingSlot) => void;
  onRemove: (slot: WorkingSlot) => void;
}) {
  const published = periodStatus === 'published';
  const { ref, isDropTarget } = useDroppable({ id: day.date, disabled: disableDrag || published || !day.withinRange });
  return (
    <CalendarDayCell
      ref={ref}
      day={day}
      className={isDropTarget ? 'calendar-cell--target' : ''}
      onSelectDate={day.withinRange ? onAdd : undefined}
    >
      {slots.map((slot) => (
        <DraggableSlot
          key={slot.id}
          slot={slot}
          timeZone={timeZone}
          periodStatus={periodStatus}
          disabled={disableDrag || published || slot.original?.status === 'cancelled'}
          onEdit={() => onEdit(slot)}
          onRemove={() => onRemove(slot)}
        />
      ))}
    </CalendarDayCell>
  );
}

function DraggableSlot({
  slot,
  timeZone,
  periodStatus,
  disabled,
  onEdit,
  onRemove,
}: {
  slot: WorkingSlot;
  timeZone: string;
  periodStatus: OpenDayPeriodStatus;
  disabled: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { ref, handleRef, isDragging } = useDraggable({ id: slot.id, disabled });
  const presentation = workingSlotPresentation(slot);
  const cancelled = slot.original?.status === 'cancelled';
  const actions = cancelled ? undefined : (
    <>
      <Button hasIconOnly kind="ghost" size="sm" renderIcon={Edit} iconDescription="Edit Open Day" onClick={onEdit} />
      <Button
        hasIconOnly
        kind="danger--ghost"
        size="sm"
        renderIcon={periodStatus === 'draft' || !slot.serverId ? TrashCan : Misuse}
        iconDescription={removalButtonLabel([slot], periodStatus)}
        onClick={onRemove}
      />
    </>
  );
  return (
    <div ref={ref}>
      <CalendarEvent
        kind={presentation.kind}
        timeLabel={`${timeInTimeZone(slot.startsAt, timeZone)}–${timeInTimeZone(slot.endsAt, timeZone)}`}
        statusLabel={presentation.label}
        statusIcon={presentation.Icon}
        assignmentLabel={slot.original?.myAssignment ? 'Your assignment' : undefined}
        assignmentIcon={UserAvatarFilledAlt}
        registeredCount={slot.original ? registeredPeopleCount(slot.original) : 0}
        onActivate={onEdit}
        mainRef={handleRef}
        disabled={cancelled}
        dragging={isDragging}
        ariaLabel={`${disabled ? 'Edit' : 'Drag or edit'} Open Day ${timeInTimeZone(slot.startsAt, timeZone)} to ${timeInTimeZone(slot.endsAt, timeZone)}`}
        actions={actions}
      />
    </div>
  );
}
