import type { OpenDay, StaffingRequirementInput } from '../../api/generated/models';
import { timeInTimeZone, zonedDateTimeToISO } from './dateTime';

export type WorkingSlot = {
  id: string;
  serverId?: string;
  original?: OpenDay;
  startsAt: string;
  endsAt: string;
  internalNote?: string | null;
  requirements: StaffingRequirementInput[];
};

export type EditorState = {
  slots: WorkingSlot[];
  previous: { slots: WorkingSlot[]; dirty: boolean } | null;
  dirty: boolean;
};

export type ScheduleEditorAction =
  | { type: 'reset'; slots: WorkingSlot[] }
  | { type: 'add'; slot: WorkingSlot }
  | { type: 'update'; slot: WorkingSlot }
  | { type: 'remove'; id: string }
  | { type: 'move'; id: string; date: string; timeZone: string }
  | { type: 'undo' };

export function scheduleEditorReducer(state: EditorState, action: ScheduleEditorAction): EditorState {
  if (action.type === 'reset') return { slots: action.slots, previous: null, dirty: false };
  if (action.type === 'undo') return state.previous ? { slots: state.previous.slots, previous: null, dirty: state.previous.dirty } : state;
  const previous = { slots: state.slots, dirty: state.dirty };
  if (action.type === 'add') return { slots: [...state.slots, action.slot], previous, dirty: true };
  if (action.type === 'update') return { slots: state.slots.map((slot) => slot.id === action.slot.id ? action.slot : slot), previous, dirty: true };
  if (action.type === 'remove') return { slots: state.slots.filter((slot) => slot.id !== action.id), previous, dirty: true };
  const slot = state.slots.find((item) => item.id === action.id);
  if (!slot) return state;
  const duration = new Date(slot.endsAt).getTime() - new Date(slot.startsAt).getTime();
  const moved = new Date(
    zonedDateTimeToISO(
      action.date,
      timeInTimeZone(slot.startsAt, action.timeZone),
      action.timeZone,
    ),
  );
  return {
    slots: state.slots.map((item) => item.id === action.id ? { ...item, startsAt: moved.toISOString(), endsAt: new Date(moved.getTime() + duration).toISOString() } : item),
    previous,
    dirty: true,
  };
}
