import type { OpenDay, OpenDaySeries } from '../../../api/generated/models';
import { clockOf, dateOf } from './dates';
import type { SlotValue } from './timeslots';

/** The editable facts of one open day. All timeslots of a day share places and restrictions in the UI. */
export type DayValues = {
  date: string;
  slots: SlotValue[];
  supervisorPlaces: number;
  traineePlaces: number;
  /** Extra roles of which any one suffices; empty means membership alone decides. */
  supervisorRoleIds: string[];
  traineeRoleIds: string[];
  note: string;
};

/** The editable template of a weekly series. */
export type SeriesValues = {
  weekday: number;
  fromDate: string;
  untilDate: string;
  /** Changes apply to not yet started days from this date on. */
  applyFrom: string;
  slots: { start: string; end: string }[];
  supervisorPlaces: number;
  traineePlaces: number;
  supervisorRoleIds: string[];
  traineeRoleIds: string[];
  /** Holiday or break dates that get an open day on purpose. */
  forcedDates: string[];
};

/**
 * Everything the Leitung changed locally and has not saved yet. The page shows the server's schedule with these edits
 * laid over it (`deriveSchedule`) and saves them as one atomic delta (`buildDelta`).
 */
export type Edits = {
  /** By server open day id. */
  dayEdits: Record<string, DayValues>;
  /** Server open days to delete (draft period) or cancel. */
  removed: string[];
  creates: { key: string; values: DayValues }[];
  /** By server series id. */
  seriesEdits: Record<string, SeriesValues>;
  seriesCreates: { key: string; values: SeriesValues }[];
  /** Server open days that follow their series again. */
  rejoins: string[];
};

export const noEdits: Edits = {
  dayEdits: {},
  removed: [],
  creates: [],
  seriesEdits: {},
  seriesCreates: [],
  rejoins: [],
};

export function editCount(edits: Edits): number {
  return (
    Object.keys(edits.dayEdits).length +
    edits.removed.length +
    edits.creates.length +
    Object.keys(edits.seriesEdits).length +
    edits.seriesCreates.length +
    edits.rejoins.length
  );
}

const sorted = (values: string[]) => [...values].sort();

/** The values of a saved open day; places and roles come from its first timeslot. */
export function valuesOfDay(day: OpenDay): DayValues {
  const first = day.timeslots[0];
  const sup = first?.requirements.find((item) => item.kind === 'supervisor');
  const tr = first?.requirements.find((item) => item.kind === 'trainee');
  return {
    date: dateOf(day.startsAt),
    slots: day.timeslots.map((slot) => ({ id: slot.id, start: clockOf(slot.startsAt), end: clockOf(slot.endsAt) })),
    supervisorPlaces: sup?.requiredCount ?? 0,
    traineePlaces: tr?.requiredCount ?? 0,
    supervisorRoleIds: sup?.eligibleRoleIds ?? [],
    traineeRoleIds: tr?.eligibleRoleIds ?? [],
    note: day.internalNote ?? '',
  };
}

export function valuesOfSeries(series: OpenDaySeries, applyFrom: string): SeriesValues {
  return {
    weekday: series.weekday,
    fromDate: series.fromDate,
    untilDate: series.untilDate,
    applyFrom,
    slots: series.timeslots.map((slot) => ({ start: slot.startTime, end: slot.endTime })),
    supervisorPlaces: series.supervisorPlaces,
    traineePlaces: series.traineePlaces,
    supervisorRoleIds: series.supervisorRoleIds,
    traineeRoleIds: series.traineeRoleIds,
    forcedDates: series.forcedDates,
  };
}

/** Whether the edit changes timeslots, places or restrictions, which takes a series day out of its series. */
export function scheduleChanged(before: DayValues, after: DayValues): boolean {
  return (
    before.date !== after.date ||
    before.slots.length !== after.slots.length ||
    before.slots.some((slot, i) => slot.start !== after.slots[i].start || slot.end !== after.slots[i].end) ||
    before.supervisorPlaces !== after.supervisorPlaces ||
    before.traineePlaces !== after.traineePlaces ||
    sorted(before.supervisorRoleIds).join() !== sorted(after.supervisorRoleIds).join() ||
    sorted(before.traineeRoleIds).join() !== sorted(after.traineeRoleIds).join()
  );
}

export type EditorState = { edits: Edits; previous: Edits | null };
export const initialEditorState: EditorState = { edits: noEdits, previous: null };

export type EditorAction =
  | { type: 'reset' }
  | { type: 'undo' }
  /** `id` is a saved open day id or the key of an unsaved single day. */
  | { type: 'editDay'; id: string; values: DayValues }
  | { type: 'editDays'; changes: Record<string, DayValues> }
  | { type: 'addDay'; key: string; values: DayValues }
  | { type: 'remove'; ids: string[] }
  /** `id` is a saved series id or the key of an unsaved series. */
  | { type: 'editSeries'; id: string; values: SeriesValues }
  | { type: 'addSeries'; key: string; values: SeriesValues }
  | { type: 'discardSeries'; key: string }
  | { type: 'rejoin'; id: string };

export function editorReducer(state: EditorState, action: EditorAction): EditorState {
  if (action.type === 'reset') return initialEditorState;
  if (action.type === 'undo') return state.previous ? { edits: state.previous, previous: null } : state;
  const edits = applyAction(state.edits, action);
  return edits === state.edits ? state : { edits, previous: state.edits };
}

function setDay(edits: Edits, id: string, values: DayValues): Edits {
  if (edits.creates.some((item) => item.key === id))
    return { ...edits, creates: edits.creates.map((item) => (item.key === id ? { ...item, values } : item)) };
  return { ...edits, dayEdits: { ...edits.dayEdits, [id]: values } };
}

function applyAction(edits: Edits, action: Exclude<EditorAction, { type: 'reset' | 'undo' }>): Edits {
  switch (action.type) {
    case 'editDay':
      return setDay(edits, action.id, action.values);
    case 'editDays':
      return Object.entries(action.changes).reduce((acc, [id, values]) => setDay(acc, id, values), edits);
    case 'addDay':
      return { ...edits, creates: [...edits.creates, { key: action.key, values: action.values }] };
    case 'remove': {
      const ids = new Set(action.ids);
      const dayEdits = Object.fromEntries(Object.entries(edits.dayEdits).filter(([id]) => !ids.has(id)));
      return {
        ...edits,
        creates: edits.creates.filter((item) => !ids.has(item.key)),
        dayEdits,
        rejoins: edits.rejoins.filter((id) => !ids.has(id)),
        removed: [
          ...edits.removed,
          ...action.ids.filter((id) => !id.startsWith('new-') && !edits.removed.includes(id)),
        ],
      };
    }
    case 'editSeries':
      if (edits.seriesCreates.some((item) => item.key === action.id))
        return {
          ...edits,
          seriesCreates: edits.seriesCreates.map((item) =>
            item.key === action.id ? { ...item, values: action.values } : item,
          ),
        };
      return { ...edits, seriesEdits: { ...edits.seriesEdits, [action.id]: action.values } };
    case 'addSeries':
      return { ...edits, seriesCreates: [...edits.seriesCreates, { key: action.key, values: action.values }] };
    case 'discardSeries':
      return { ...edits, seriesCreates: edits.seriesCreates.filter((item) => item.key !== action.key) };
    case 'rejoin':
      return edits.rejoins.includes(action.id) ? edits : { ...edits, rejoins: [...edits.rejoins, action.id] };
  }
}
