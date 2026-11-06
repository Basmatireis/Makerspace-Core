import { describe, expect, it } from 'vitest';
import type { StaffingRules, SupervisorRow } from '../../api/generated/models';
import { exceptionNote, isDirty, isValid, toDraft, toRequest, validateDraft } from './staffingRules';

const rules: StaffingRules = {
  supervisorMinimum: 3,
  traineeMinimum: 2,
  traineeReadyAfter: 3,
  warningWindowDays: 14,
  countBy: 'timeslot',
  defaultDeadline: 'period_end',
  exceptions: [{ roleId: 'r1', roleName: 'Laser', minimum: 1 }],
  version: 4,
  updatedAt: '2026-10-01T00:00:00Z',
};

describe('staffing rules draft', () => {
  it('is clean until a field changes and clean again when changed back', () => {
    const draft = toDraft(rules);
    expect(isDirty(draft, rules)).toBe(false);
    expect(isDirty({ ...draft, supervisorMinimum: '4' }, rules)).toBe(true);
    expect(isDirty({ ...draft, supervisorMinimum: '3' }, rules)).toBe(false);
  });

  it('validates the ranges of the API', () => {
    const draft = toDraft(rules);
    expect(isValid(validateDraft(draft))).toBe(true);
    const bad = validateDraft({
      ...draft,
      traineeReadyAfter: '0',
      warningWindowDays: '61',
      supervisorMinimum: '',
      exceptions: [{ roleId: 'r1', roleName: 'Laser', minimum: '21' }],
    });
    expect(Object.keys(bad.numbers).sort()).toEqual(['supervisorMinimum', 'traineeReadyAfter', 'warningWindowDays']);
    expect(bad.exceptions.r1).toBeDefined();
    expect(isValid(bad)).toBe(false);
  });

  it('builds the request with the version the edit started from', () => {
    const request = toRequest({ ...toDraft(rules), warningWindowDays: '21' }, 4);
    expect(request).toMatchObject({
      warningWindowDays: 21,
      expectedVersion: 4,
      exceptions: [{ roleId: 'r1', minimum: 1 }],
    });
  });

  it('explains what an exception changes', () => {
    const holder = { membership: 'supervisor', extraRoles: ['Laser'] } as SupervisorRow;
    const draft = { supervisorMinimum: '3', traineeMinimum: '2' };
    expect(exceptionNote({ roleName: 'Laser', minimum: '1' }, [holder], draft)).toContain(
      'lowers the minimum for them',
    );
    expect(exceptionNote({ roleName: 'Laser', minimum: '5' }, [holder], draft)).toContain('changes nothing');
    expect(exceptionNote({ roleName: 'Wood', minimum: '1' }, [holder], draft)).toBe('Nobody has this role yet.');
  });
});
