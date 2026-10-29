import { describe, expect, it } from 'vitest';
import type { SubjectRequest } from '../../api/generated/models';
import { matchesRequestSearch, type Actor } from './privacyRequests';

const actor: Actor = { accountId: 'me', canManage: true, canExecute: false };
const request = {
  id: 'r1',
  kind: 'erasure',
  status: 'assessed',
  personName: 'Max Mustermann',
  identityVerifiedByName: 'Lena K.',
  identityVerifiedBy: 'someone',
  identityVerifiedAt: '2026-10-01T10:00:00Z',
  reference: 'DSR-1',
  channel: 'email',
  receivedAt: '2026-09-20T10:00:00Z',
  assessment: null,
  steps: [],
} as unknown as SubjectRequest;

describe('data request search', () => {
  it('matches the kind, the status label and the actor names the table shows', () => {
    expect(matchesRequestSearch(request, 'erasure', actor)).toBe(true);
    expect(matchesRequestSearch(request, 'assessed', actor)).toBe(true);
    expect(matchesRequestSearch(request, 'lena', actor)).toBe(true);
    expect(matchesRequestSearch(request, 'approve the erasure', actor)).toBe(true);
  });

  it('still matches the person and the reference, and rejects unrelated terms', () => {
    expect(matchesRequestSearch(request, 'mustermann', actor)).toBe(true);
    expect(matchesRequestSearch(request, 'dsr-1', actor)).toBe(true);
    expect(matchesRequestSearch(request, '', actor)).toBe(true);
    expect(matchesRequestSearch(request, 'access', actor)).toBe(false);
    expect(matchesRequestSearch(request, 'rejected', actor)).toBe(false);
  });
});
