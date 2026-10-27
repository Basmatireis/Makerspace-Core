import type { PeopleMergeCandidate, PeopleMergePreview } from '../../../api/generated/models';

export function candidate(id: string, overrides: Partial<PeopleMergeCandidate> = {}): PeopleMergeCandidate {
  return {
    id,
    version: 1,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: null,
    phone: null,
    photoReference: null,
    profileImage: null,
    memberSince: '2026-01-01',
    createdAt: '2026-01-01T00:00:00Z',
    roles: [],
    account: null,
    scimManaged: false,
    ...overrides,
  };
}

export function previewOf(people: PeopleMergeCandidate[], overrides: Partial<PeopleMergePreview> = {}) {
  return {
    targetPersonId: people[0].id,
    people,
    resultingRoles: [],
    survivingAccountId: null,
    history: [],
    conflicts: [],
    canMerge: true,
    ...overrides,
  } satisfies PeopleMergePreview;
}
