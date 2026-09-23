import { describe, expect, it } from 'vitest';
import type { AuditEvent } from '../../api/generated/models';
import { presentAction, presentActor, presentTarget } from './presentation';

function event(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: '0192f6f8-743e-7c77-a349-cd07c3e8a921',
    actorType: 'user',
    actorAccountId: '0192f6f8-743e-7c77-a349-cd07c3e8a922',
    actorDisplayName: 'Ada Lovelace',
    action: 'person.updated',
    resourceType: 'person',
    resourceId: '0192f6f8-743e-7c77-a349-cd07c3e8a923',
    resourceDisplayName: 'Grace Hopper',
    occurredAt: '2026-09-23T08:00:00Z',
    requestId: null,
    changedFields: [],
    metadata: {},
    resolvedMetadata: {},
    source: 'http',
    ...overrides,
  };
}

describe('activity presentation', () => {
  it('renders current labels for people, roles, Open Days, devices, Lab Rules, authentication, and system events', () => {
    expect(presentAction(event())).toBe('Updated person');
    expect(presentAction(event({ action: 'account.role_assigned', resolvedMetadata: { roleId: 'Supervisors' } }))).toBe('Assigned role: Supervisors');
    expect(presentAction(event({ action: 'open_day_period.published' }))).toBe('Published Open Day period');
    expect(presentAction(event({ action: 'managed_device.revoked' }))).toBe('Revoked managed device');
    expect(presentAction(event({ action: 'laborordnung.version.published' }))).toBe('Published Lab Rules version');
    expect(presentAction(event({ action: 'auth.login_succeeded' }))).toBe('Signed in');
    expect(presentActor(event({ actorType: 'system', actorDisplayName: null, actorAccountId: null }))).toBe('System');
  });

  it('safely renders deleted records and future identifiers', () => {
    expect(presentActor(event({ actorDisplayName: null, actorAccountId: null }))).toBe('Deleted user');
    expect(presentTarget(event({ resourceDisplayName: null }))).toMatch(/^Person · 0192f6f8…$/);
    expect(presentAction(event({ action: 'future_domain.did_something' }))).toBe('Future domain did something');
  });

  it('uses resolved assignment metadata without retaining names in the event metadata', () => {
    expect(presentTarget(event({
      resourceType: 'open_day_assignment',
      resourceDisplayName: null,
      resolvedMetadata: { personId: 'Ada Lovelace', openDayId: '2026-09-24T14:00:00Z' },
    }))).toContain('Ada Lovelace');
  });
});
