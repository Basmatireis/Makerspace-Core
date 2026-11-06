import type { SupervisorRow } from '../../../api/generated/models';

export type Candidate = { personId: string; displayName: string };

/** Eligible people first who are furthest below their minimum, then those with fewer sign-ups, then by name. */
export function sortCandidates(people: Candidate[], rows: ReadonlyMap<string, SupervisorRow>): Candidate[] {
  const need = (personId: string) => {
    const row = rows.get(personId);
    return row
      ? { missing: row.missing > 0 ? 1 : 0, count: row.staffed + row.booked }
      : { missing: 0, count: Number.MAX_SAFE_INTEGER };
  };
  return [...people].sort((a, b) => {
    const x = need(a.personId);
    const y = need(b.personId);
    return y.missing - x.missing || x.count - y.count || a.displayName.localeCompare(b.displayName);
  });
}
