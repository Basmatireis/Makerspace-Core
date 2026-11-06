import type { OpenDay } from '../../../api/generated/models';
import { dayEnded, isShortStaffed, mySlots, placesForMe, slotEnded, type Viewer } from './state';

export type SectionId = 'upcoming' | 'short' | 'forme' | 'mine' | 'past';

export type SectionDef = { id: SectionId; label: string; count: number };

/** Whether a day belongs to a section. The past is only ever the `past` section. */
export function inSection(day: OpenDay, section: SectionId, now: Date): boolean {
  if (section === 'past') return dayEnded(day, now);
  if (dayEnded(day, now)) return false;
  if (section === 'short') return isShortStaffed(day, now);
  if (section === 'forme') return placesForMe(day) > 0;
  if (section === 'mine') return mySlots(day).some((slot) => !slotEnded(slot, now));
  return true;
}

/** The section tabs this viewer gets: short-staffed only for the Leitung, personal ones only for people who sign up. */
export function sectionDefs(days: OpenDay[], viewer: Viewer, now: Date): SectionDef[] {
  const count = (section: SectionId) => days.filter((day) => inSection(day, section, now)).length;
  const upcoming = days.filter((day) => day.status !== 'cancelled' && inSection(day, 'upcoming', now)).length;
  const defs: SectionDef[] = [{ id: 'upcoming', label: 'Upcoming', count: upcoming }];
  if (viewer.canManage) defs.push({ id: 'short', label: 'Short-staffed', count: count('short') });
  if (viewer.canSignUp) {
    defs.push({ id: 'forme', label: 'Open for me', count: count('forme') });
    defs.push({ id: 'mine', label: 'Mine', count: count('mine') });
  }
  defs.push({ id: 'past', label: 'Past', count: count('past') });
  return defs;
}
