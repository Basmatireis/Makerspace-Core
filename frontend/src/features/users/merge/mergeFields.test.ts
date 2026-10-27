import { describe, expect, it } from 'vitest';
import type { PeopleMergeCandidate } from '../../../api/generated/models';
import { buildFieldSources, comparedFields, defaultFieldChoices, expectedVersions } from './mergeFields';
import { candidate, previewOf } from './mergeFixtures';

describe('merge field choices', () => {
  it('keeps the target value and falls back to the first non-empty source for optional fields', () => {
    const preview = previewOf([
      candidate('t', { phone: null, firstName: 'Ada' }),
      candidate('a', { phone: '111', firstName: 'Augusta' }),
      candidate('b', { phone: '222' }),
    ]);
    const choices = defaultFieldChoices(preview);
    expect(choices.firstName).toBe('t');
    expect(choices.phone).toBe('a');
    expect(buildFieldSources(preview, choices)).toEqual({});
  });

  it('defaults the email to the person of the surviving account and sends only deviations', () => {
    const account = { id: 'acc', version: 3 } as NonNullable<PeopleMergeCandidate['account']>;
    const preview = previewOf([candidate('t'), candidate('a', { account, email: 'a@example.test' })], {
      survivingAccountId: 'acc',
    });
    const choices = defaultFieldChoices(preview);
    expect(choices.email).toBe('a');
    expect(buildFieldSources(preview, { ...choices, lastName: 'a', phone: 't' })).toEqual({ lastName: 'a' });
  });

  it('shows the matriculation number only when the response carries it', () => {
    const without = comparedFields([candidate('t'), candidate('a')]).map((row) => row.field);
    const withNumber = comparedFields([candidate('t', { matriculationNumber: null }), candidate('a')]).map(
      (row) => row.field,
    );
    expect(without).not.toContain('matriculationNumber');
    expect(withNumber).toContain('matriculationNumber');
  });

  it('collects one expected version per person with a null account version when there is no account', () => {
    const account = { id: 'acc', version: 7 } as NonNullable<PeopleMergeCandidate['account']>;
    const preview = previewOf([candidate('t', { version: 2 }), candidate('a', { account })]);
    expect(expectedVersions(preview)).toEqual([
      { personId: 't', version: 2, accountVersion: null },
      { personId: 'a', version: 1, accountVersion: 7 },
    ]);
  });
});
