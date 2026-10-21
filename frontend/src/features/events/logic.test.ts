import { describe, expect, it } from 'vitest';
import {
  availabilityOf,
  checklist,
  joinReasonLabel,
  nextSteps,
  previewPublicEvent,
  programme,
  signupTag,
} from './logic';
import { eventFixture, participationFixture, sessionFixture, shiftFixture } from './testData';

describe('programme', () => {
  it('groups sessions with their shifts by day and keeps unattached shifts apart', () => {
    const early = sessionFixture({ id: 's-early', startsAt: '2026-11-02T10:00:00Z', endsAt: '2026-11-02T12:00:00Z' });
    const nextDay = sessionFixture({ id: 's-next', startsAt: '2026-11-03T10:00:00Z', endsAt: '2026-11-03T12:00:00Z' });
    const attached = shiftFixture({ id: 'sh-1', sessionId: 's-early', startsAt: '2026-11-02T10:00:00Z' });
    const setup = shiftFixture({ id: 'sh-2', sessionId: null, startsAt: '2026-11-02T08:00:00Z' });
    const orphan = shiftFixture({ id: 'sh-3', sessionId: 'deleted', startsAt: '2026-11-04T08:00:00Z' });
    const days = programme([nextDay, early], [orphan, attached, setup]);
    expect(days.map((day) => day.key)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04']);
    expect(days[0].sessions[0].shifts.map((shift) => shift.id)).toEqual(['sh-1']);
    expect(days[0].loose.map((shift) => shift.id)).toEqual(['sh-2']);
    expect(days[2].loose.map((shift) => shift.id)).toEqual(['sh-3']);
  });
});

describe('go live wording', () => {
  it('marks only the unmet items of a checklist', () => {
    const items = checklist(['owner_missing', 'public_title_missing'], ['public_title_missing']);
    expect(items.map((item) => [item.code, item.ok, item.fix])).toEqual([
      ['owner_missing', true, 'details'],
      ['public_title_missing', false, 'public'],
    ]);
  });

  it('names the helper signup state', () => {
    const goLive = eventFixture().goLive;
    expect(signupTag(goLive)).toEqual({ label: 'Open', type: 'green' });
    expect(signupTag({ ...goLive, helperSignup: { state: 'off', unmet: [] } }).label).toBe('Off');
    expect(
      signupTag({ ...goLive, helperSignup: { state: 'opens_at', opensAt: '2026-10-22T08:00:00Z', unmet: [] } }).label,
    ).toBe('Opens 22 Oct');
  });
});

describe('next steps', () => {
  const now = Date.parse('2026-10-20T10:00:00Z');
  it('lists what the server says is missing, then what is open', () => {
    const steps = nextSteps(
      eventFixture({
        status: 'draft',
        openPlaces: 3,
        tasksOverdue: 2,
        goLive: {
          ...eventFixture().goLive,
          confirmUnmet: ['owner_missing'],
          publicPage: { state: 'off', unmet: ['owner_missing', 'public_title_missing'] },
        },
      }),
      now,
      1,
    );
    expect(steps.map((step) => step.id)).toEqual(['owner', 'title', 'open', 'unlinked', 'overdue']);
  });

  it('offers confirming, going live and completing when nothing blocks them', () => {
    const draft = nextSteps(
      eventFixture({
        status: 'draft',
        openPlaces: 0,
        tasksOverdue: 0,
        goLive: { ...eventFixture().goLive, publicPage: { state: 'off', unmet: [] } },
      }),
      now,
    );
    expect(draft.map((step) => step.id)).toEqual(['confirm', 'live']);
    const over = nextSteps(eventFixture({ openPlaces: 0, tasksOverdue: 0 }), Date.parse('2026-11-03T00:00:00Z'));
    expect(over.map((step) => step.id)).toEqual(['complete']);
  });

  it('only lists follow-up tasks for closed events', () => {
    expect(nextSteps(eventFixture({ status: 'completed', taskTotal: 3, taskCompleted: 1 }), now)).toEqual([
      { id: 'tasks', label: '2 follow-up tasks still open', tab: 'tasks' },
    ]);
  });
});

describe('join reasons', () => {
  it('words every reason a position cannot be joined', () => {
    const position = participationFixture().shifts[0].positions[0];
    expect(joinReasonLabel({ ...position, reason: 'full' })).toBe('Full');
    expect(joinReasonLabel({ ...position, reason: 'opens_at', opensAt: '2026-10-22T08:00:00Z' })).toBe('Opens 22 Oct');
    expect(joinReasonLabel({ ...position, reason: 'roles_only', roleNames: ['A', 'B'] })).toBe(
      'Members with role A or B only',
    );
    expect(joinReasonLabel({ ...position, reason: 'no_permission' })).toBeNull();
  });
});

describe('public preview', () => {
  it('shows only public, scheduled content and computes availability like the server', () => {
    const now = Date.parse('2026-10-20T10:00:00Z');
    const preview = previewPublicEvent(
      eventFixture(),
      [sessionFixture(), sessionFixture({ id: 'internal', isPublic: false })],
      [
        shiftFixture(),
        shiftFixture({ id: 'hidden', isPublic: false }),
        shiftFixture({ id: 'gone', status: 'cancelled' }),
      ],
      [],
      now,
    );
    expect(preview.sessions.map((session) => session.id)).toEqual([expect.any(String)]);
    expect(preview.sessions).toHaveLength(1);
    expect(preview.shifts).toHaveLength(1);
    expect(preview.shifts[0].requirements.map((r) => r.availability)).toEqual(['available', 'authenticated_only']);
    const draft = previewPublicEvent(eventFixture({ status: 'draft' }), [], [shiftFixture()], [], now);
    expect(draft.shifts[0].requirements.every((r) => r.availability === 'not_open')).toBe(true);
    expect(draft.publicSignupEnabled).toBe(false);
  });

  it('marks places of an ended shift as closed instead of not open yet', () => {
    const afterShift = Date.parse('2026-11-03T10:00:00Z');
    const preview = previewPublicEvent(eventFixture(), [], [shiftFixture()], [], afterShift);
    expect(preview.shifts[0].requirements.every((r) => r.availability === 'closed')).toBe(true);
    expect(availabilityOf(preview.shifts[0].requirements[0], false, true)).toMatchObject({
      label: 'Signup closed',
      canSignUp: false,
    });
  });
});
