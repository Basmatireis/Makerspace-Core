/** A timeslot in makerspace wall-clock time (`HH:MM`); `id` is set for a timeslot that already exists on the server. */
export type SlotValue = { id?: string; start: string; end: string };

export const toMinutes = (time: string) => {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
};

export const fromMinutes = (total: number) =>
  `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;

/** Consecutive slots of `hours` each, the last one cut at `to`. */
export function splitByHours(from: string, to: string, hours: number): { start: string; end: string }[] {
  const step = Math.max(15, Math.round((hours * 60) / 15) * 15);
  const slots: { start: string; end: string }[] = [];
  for (let minute = toMinutes(from); minute < toMinutes(to); minute += step) {
    slots.push({ start: fromMinutes(minute), end: fromMinutes(Math.min(minute + step, toMinutes(to))) });
  }
  return slots;
}

/** About `parts` equal slots, rounded to quarter hours. */
export function splitIntoParts(from: string, to: string, parts: number): { start: string; end: string }[] {
  const total = toMinutes(to) - toMinutes(from);
  const step = Math.max(15, Math.round(total / Math.max(1, Math.round(parts)) / 15) * 15);
  return splitByHours(from, to, step / 60);
}

/** The next slot to offer after the last one: three hours, clamped to the day. */
export function nextSlot(slots: readonly { start: string; end: string }[]): { start: string; end: string } {
  const start = Math.min(toMinutes(slots[slots.length - 1]?.end ?? '16:00'), 23 * 60);
  return { start: fromMinutes(start), end: fromMinutes(Math.min(start + 180, 23 * 60 + 45)) };
}

/** The first problem with a list of timeslots, or an empty string. */
export function slotsError(slots: readonly { start: string; end: string }[]): string {
  if (!slots.length) return 'Add at least one timeslot.';
  if (slots.some((slot) => !slot.start || !slot.end)) return 'Every timeslot needs a start and an end.';
  if (slots.some((slot) => toMinutes(slot.end) <= toMinutes(slot.start))) return 'A timeslot must end after it starts.';
  const sorted = [...slots].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
  if (sorted.some((slot, index) => index > 0 && toMinutes(slot.start) < toMinutes(sorted[index - 1].end)))
    return 'Timeslots must not overlap.';
  return '';
}

/** The overall range of a day in minutes since midnight. */
export function overallRange(slots: readonly { start: string; end: string }[]): [number, number] {
  const starts = slots.map((slot) => toMinutes(slot.start));
  const ends = slots.map((slot) => toMinutes(slot.end));
  return [Math.min(...starts), Math.max(...ends)];
}

export function rangesOverlap(a: readonly [number, number], b: readonly [number, number]) {
  return a[0] < b[1] && a[1] > b[0];
}

export const slotSummary = (slots: readonly { start: string; end: string }[]) =>
  `${slots[0]?.start}–${slots[slots.length - 1]?.end}${slots.length > 1 ? ` · ${slots.length} timeslots` : ''}`;
