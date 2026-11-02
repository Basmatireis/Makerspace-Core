import { describe, expect, it } from 'vitest';
import { DEFAULT_RULE_ID, resolvePlayback, type PlaybackRule } from '../features/signage/engine/playback';
import { noCameraSource } from './camera';
import { live, manifest, only, rule, scene } from './testFixtures';
import { holdResult, resolveView, LIVE_TTL_MS, type Hold, type LiveSnapshot } from './view';

const result = (rules: PlaybackRule[], printing: string[] = []) =>
  resolvePlayback(only('scene-a'), rules, {
    now: new Date(2026, 9, 19, 12),
    printingMachineIds: printing,
    activeAnnouncementTemplateIds: [],
    liveDataAvailable: true,
  });
const printingRule = (id: string, minSeconds: number): PlaybackRule =>
  rule(id, { kind: 'machine_printing', machineIds: ['m1'], machineMatch: 'any', minSeconds }) as PlaybackRule;
const announcementRule = (id: string): PlaybackRule =>
  rule(id, { kind: 'announcement_active', minSeconds: 0 }) as PlaybackRule;

describe('minimum display time', () => {
  const first = result([printingRule('print', 30)], ['m1']);
  const idle = result([printingRule('print', 30)]);

  it('adopts the first result', () => {
    const { hold, result: shown } = holdResult(null, first, 1_000);
    expect(shown.ruleId).toBe('print');
    expect(hold).toMatchObject({ ruleId: 'print', since: 1_000, minSeconds: 30 });
  });

  it('keeps the winning rule on screen for min_seconds after its condition ended', () => {
    const { hold } = holdResult(null, first, 0);
    expect(holdResult(hold, idle, 29_999).result.ruleId).toBe('print');
    expect(holdResult(hold, idle, 30_000).result.ruleId).toBe(DEFAULT_RULE_ID);
  });

  it('lets a higher-priority rule take over immediately', () => {
    const rules = [announcementRule('urgent'), printingRule('print', 30)];
    const { hold } = holdResult(
      null,
      resolvePlayback(only('scene-a'), rules.slice(1), {
        now: new Date(),
        printingMachineIds: ['m1'],
        activeAnnouncementTemplateIds: [],
        liveDataAvailable: true,
      }),
      0,
    );
    const urgent = resolvePlayback(only('scene-a'), rules, {
      now: new Date(),
      printingMachineIds: ['m1'],
      activeAnnouncementTemplateIds: ['t'],
      liveDataAvailable: true,
    });
    expect(urgent.ruleId).toBe('urgent');
    expect(holdResult({ ...hold, position: 2 }, urgent, 5_000).result.ruleId).toBe('urgent');
  });

  it('does not let a lower-priority rule interrupt a held one', () => {
    const rules = [printingRule('print', 30), announcementRule('note')];
    const { hold } = holdResult(
      null,
      resolvePlayback(only('scene-a'), rules, {
        now: new Date(),
        printingMachineIds: ['m1'],
        activeAnnouncementTemplateIds: [],
        liveDataAvailable: true,
      }),
      0,
    );
    const lower = resolvePlayback(only('scene-a'), [rules[1]], {
      now: new Date(),
      printingMachineIds: [],
      activeAnnouncementTemplateIds: ['t'],
      liveDataAvailable: true,
    });
    expect(holdResult(hold, lower, 10_000).result.ruleId).toBe('print');
  });

  it('keeps the clock of a rule that keeps matching', () => {
    const { hold } = holdResult(null, first, 0);
    expect(holdResult(hold, first, 50_000).hold.since).toBe(0);
  });
});

describe('resolveView', () => {
  const base = { camera: noCameraSource, assetUrl: () => null, hold: null as Hold | null };
  const snapshot = (patch: Partial<LiveSnapshot> = {}): LiveSnapshot => ({ ...live(), skewMs: 0, ...patch });

  it('shows the live_data_unavailable rule when the last live poll is older than 60 s', () => {
    const m = manifest(1, { rules: [rule('offline', { scenes: only('scene-b') })] });
    const now = 1_000_000;
    expect(
      resolveView({ ...base, manifest: m, live: snapshot(), lastLiveAt: now - LIVE_TTL_MS, now }).view.sceneId,
    ).toBe('scene-a');
    expect(
      resolveView({ ...base, manifest: m, live: snapshot(), lastLiveAt: now - LIVE_TTL_MS - 1, now }).view.sceneId,
    ).toBe('scene-b');
    expect(resolveView({ ...base, manifest: m, live: null, lastLiveAt: null, now }).view.data.liveAvailable).toBe(
      false,
    );
  });

  it('does not trust machine states without fresh live data', () => {
    const machines = [
      {
        machineId: 'm1',
        name: 'H2D',
        state: 'printing' as const,
        progressPercent: 10,
        remainingMinutes: 5,
        observedAt: null,
        stale: false,
      },
    ];
    const m = manifest(1, {
      rules: [
        rule('print', { kind: 'machine_printing', machineIds: ['m1'], machineMatch: 'any', scenes: only('scene-b') }),
      ],
    });
    expect(
      resolveView({ ...base, manifest: m, live: snapshot({ machines }), lastLiveAt: 1_000, now: 1_000 }).view.sceneId,
    ).toBe('scene-b');
    expect(
      resolveView({
        ...base,
        manifest: m,
        live: snapshot({ machines }),
        lastLiveAt: 1_000,
        now: 1_000 + 2 * LIVE_TTL_MS,
      }).view.sceneId,
    ).toBe('scene-a');
  });

  it('marks cameras without a stream unavailable so widgets use their fallback', () => {
    const machines = [
      {
        machineId: 'm1',
        name: 'H2D',
        state: 'printing' as const,
        progressPercent: null,
        remainingMinutes: null,
        observedAt: null,
        stale: false,
      },
    ];
    const { view } = resolveView({
      ...base,
      manifest: manifest(1),
      live: snapshot({ machines }),
      lastLiveAt: 0,
      now: 0,
    });
    expect(view.data.unavailableCameras?.has('m1')).toBe(true);
  });

  it('rotates a scene list from the moment it took the screen, with the item transition', () => {
    const m = manifest(1, {
      scenes: [scene('scene-a'), scene('scene-b')],
      defaultScenes: [
        { sceneId: 'scene-a', seconds: 10, transition: 'cut' },
        { sceneId: 'scene-b', seconds: 10, transition: 'fade' },
      ],
    });
    const first = resolveView({ ...base, manifest: m, live: null, lastLiveAt: null, now: 100_000 });
    expect(first.view).toMatchObject({ sceneId: 'scene-a', transition: 'cut' });
    const later = resolveView({ ...base, manifest: m, live: null, lastLiveAt: null, now: 112_000, hold: first.hold });
    expect(later.view).toMatchObject({ sceneId: 'scene-b', transition: 'fade' });
    expect(later.view.sceneKey).not.toBe(first.view.sceneKey);
    expect(
      resolveView({ ...base, manifest: m, live: null, lastLiveAt: null, now: 121_000, hold: first.hold }).view.sceneId,
    ).toBe('scene-a');
  });

  it('hands layouts, calendar, asset names and announcement formats to the renderer', () => {
    const calendar = { from: '2026-10-01', to: '2026-12-01', holidays: [], breaks: [], openDays: [], events: [] };
    const customLayouts = [
      { id: 'cl', name: 'L', mode: 'grid' as const, columns: [1], rows: [1], zones: [], version: 1 },
    ];
    const announcement = {
      id: 'a1',
      templateId: 't',
      tone: 'info' as const,
      title: 'T',
      body: '**b**',
      bodyFormat: 'markdown' as const,
      bodyCss: 'p{}',
      startsAt: new Date(0).toISOString(),
      endsAt: null,
    };
    const { view } = resolveView({
      ...base,
      assetName: (id) => (id === 'f' ? 'Fira' : null),
      manifest: manifest(1, { customLayouts }),
      live: snapshot({ calendar, announcements: [announcement] }),
      lastLiveAt: 1_000,
      now: 1_000,
    });
    expect(view.data.customLayouts).toEqual(customLayouts);
    expect(view.data.calendar).toEqual(calendar);
    expect(view.data.assetName?.('f')).toBe('Fira');
    expect(view.data.announcements[0]).toMatchObject({ bodyFormat: 'markdown', bodyCss: 'p{}', body: '**b**' });
  });

  it('hands the timelapse clips and their playable URL to the renderer', () => {
    const clip = {
      runId: 'r1',
      machineId: 'm1',
      machineName: 'MK4',
      endedAt: new Date(0).toISOString(),
      sha256: 'ab'.repeat(32),
      sizeBytes: 10,
      url: `/api/v1/signage/player/timelapses/r1/${'ab'.repeat(32)}`,
    };
    const input = {
      ...base,
      manifest: manifest(1),
      live: snapshot({ timelapses: [clip] }),
      lastLiveAt: 1_000,
      now: 1_000,
    };
    const network = resolveView(input).view.data;
    expect(network.timelapses).toEqual([clip]);
    expect(network.timelapseUrl?.(clip)).toBe(clip.url);
    const notCached = resolveView({ ...input, timelapseUrl: () => null }).view.data;
    expect(notCached.timelapseUrl?.(clip)).toBeNull();
    expect(resolveView({ ...input, live: snapshot() }).view.data.timelapses).toBeNull();
  });

  it('copes with a manifest and announcements cached before custom layouts and rich text', () => {
    const old = manifest(1);
    delete (old as Partial<typeof old>).customLayouts;
    const announcement = {
      id: 'a1',
      templateId: 't',
      tone: 'info',
      title: 'T',
      body: 'b',
      startsAt: new Date(0).toISOString(),
      endsAt: null,
    };
    const { view } = resolveView({
      ...base,
      manifest: old,
      live: snapshot({ announcements: [announcement as never] }),
      lastLiveAt: 1_000,
      now: 1_000,
    });
    expect(view.data.customLayouts).toEqual([]);
    expect(view.data.calendar).toBeNull();
    expect(view.data.announcements[0]).toMatchObject({ bodyFormat: 'plain', bodyCss: '' });
  });

  it('drops announcements that ended, using the server clock', () => {
    const announcement = {
      id: 'a1',
      templateId: 't',
      tone: 'info' as const,
      title: 'Closed',
      body: '',
      bodyFormat: 'plain' as const,
      bodyCss: '',
      startsAt: new Date(0).toISOString(),
      endsAt: new Date(10_000).toISOString(),
    };
    const view = (now: number, skewMs: number) =>
      resolveView({
        ...base,
        manifest: manifest(1),
        live: snapshot({ announcements: [announcement], skewMs }),
        lastLiveAt: now,
        now,
      }).view;
    expect(view(5_000, 0).data.announcements).toHaveLength(1);
    expect(view(5_000, 6_000).data.announcements).toHaveLength(0);
    expect(view(20_000, 0).data.announcements).toHaveLength(0);
  });
});

describe('scene lists with missing scenes', () => {
  const base = { camera: noCameraSource, assetUrl: () => null, hold: null as Hold | null };
  it('skips items whose scene is not in the manifest and shows nothing when none is left', () => {
    const skipped = manifest(1, {
      defaultScenes: [
        { sceneId: 'gone', seconds: 10, transition: 'fade' },
        { sceneId: 'scene-b', seconds: 10, transition: 'cut' },
      ],
    });
    expect(resolveView({ ...base, manifest: skipped, live: null, lastLiveAt: null, now: 0 }).view.sceneId).toBe(
      'scene-b',
    );
    const none = manifest(1, { defaultScenes: only('gone') });
    expect(resolveView({ ...base, manifest: none, live: null, lastLiveAt: null, now: 0 }).view.scene).toBeNull();
  });
});
