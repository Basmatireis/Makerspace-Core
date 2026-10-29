import { describe, expect, it } from 'vitest';
import type { PrivacyCategory } from '../../api/generated/models';
import { matches, noFilters } from './categoryFilter';

const category = {
  id: 'machine_timelapse',
  name: 'Print timelapses',
  description: 'Videos of finished prints',
  contains: 'Recorded video',
  fields: ['file_name'],
  ownerModuleId: 'machine_logbook',
  subject: 'account',
  orphaned: false,
  coverage: { policyStatus: 'none', hold: null },
} as unknown as PrivacyCategory;

describe('privacy category search', () => {
  it('matches the area and the belongs-to labels the table shows', () => {
    expect(matches(category, 'machine logbook', noFilters)).toBe(true);
    expect(matches(category, 'AN ACCOUNT', noFilters)).toBe(true);
    expect(matches(category, 'timelapses', noFilters)).toBe(true);
  });

  it('does not match unrelated terms', () => {
    expect(matches(category, 'a person', noFilters)).toBe(false);
    expect(matches(category, 'signage', noFilters)).toBe(false);
  });
});
