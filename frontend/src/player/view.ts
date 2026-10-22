import type {
  SignagePlayerLive,
  SignagePlayerManifest,
  SignagePlayerScene,
  SignageTransition,
} from '../api/generated/models';
import {
  playlistPosition,
  resolvePlayback,
  type PlaybackResult,
  type PlaybackRule,
} from '../features/signage/engine/playback';
import { isPrinting, type RenderData, type RenderMachine } from '../features/signage/render/types';
import type { CameraSource } from './camera';

// Decides what is on screen: the shared engine picks the winning rule, the player adds the minimum display time
// (hysteresis) and resolves playlists. Pure functions; the runtime owns the clock and the held state.

/** Live data older than this counts as unavailable (the engine's `live_data_unavailable` rule and "Status unknown"). */
export const LIVE_TTL_MS = 60_000;

/** The rule that currently holds the screen. */
export type Hold = {
  ruleId: string;
  position: number | null;
  since: number;
  minSeconds: number;
  result: PlaybackResult;
};

/**
 * Applies the minimum display time: a rule that took the screen keeps it for `minSeconds` unless a rule of higher
 * priority (smaller position; the default playlist ranks last) matches. Afterwards the engine's result is followed.
 */
export function holdResult(
  previous: Hold | null,
  next: PlaybackResult,
  now: number,
): { hold: Hold; result: PlaybackResult } {
  const adopt = () => ({
    hold: { ruleId: next.ruleId, position: next.rulePosition, since: now, minSeconds: next.minSeconds, result: next },
    result: next,
  });
  if (!previous) return adopt();
  if (previous.ruleId === next.ruleId)
    return { hold: { ...previous, minSeconds: next.minSeconds, result: next }, result: next };
  if (now - previous.since >= previous.minSeconds * 1000) return adopt();
  if ((next.rulePosition ?? Infinity) < (previous.position ?? Infinity)) return adopt();
  return { hold: previous, result: previous.result };
}

/** Live data as the player keeps it between polls. */
export type LiveSnapshot = Pick<
  SignagePlayerLive,
  'machines' | 'announcements' | 'openDays' | 'events' | 'calendar' | 'streams'
> & {
  /** Server clock minus device clock in milliseconds, so announcement windows follow the server. */
  skewMs: number;
};

export type PlayerView = {
  scene: SignagePlayerScene | null;
  data: RenderData;
  transition: SignageTransition;
  /** Changes when another scene takes over, so the screen can fade. */
  sceneKey: string;
  ruleId: string;
  sceneId: string | null;
};

export type ViewInput = {
  manifest: SignagePlayerManifest;
  live: LiveSnapshot | null;
  /** Epoch ms of the last successful live poll; null when there was none. */
  lastLiveAt: number | null;
  now: number;
  hold: Hold | null;
  camera: CameraSource;
  assetUrl: (assetId: string) => string | null;
  /** Asset names, so fonts are registered under the name CSS uses. */
  assetName?: (assetId: string) => string | null;
};

export const liveAvailable = (lastLiveAt: number | null, now: number) =>
  lastLiveAt !== null && now - lastLiveAt <= LIVE_TTL_MS;

export function resolveView(input: ViewInput): { view: PlayerView; hold: Hold } {
  const { manifest, live, lastLiveAt, now, camera } = input;
  const available = liveAvailable(lastLiveAt, now);
  const serverNow = now + (live?.skewMs ?? 0);
  const machines: RenderMachine[] = (live?.machines ?? []).map((machine) => ({
    machineId: machine.machineId,
    name: machine.name,
    state: machine.state,
    progressPercent: machine.progressPercent,
    remainingMinutes: machine.remainingMinutes,
    stale: machine.stale,
  }));
  // Announcements stay until their end, also when live data went stale (the server decides about open-ended ones on the next poll).
  const announcements = (live?.announcements ?? [])
    .filter((item) => item.endsAt === null || Date.parse(item.endsAt) > serverNow)
    .map((item) => ({
      id: item.id,
      templateId: item.templateId,
      tone: item.tone,
      title: item.title,
      body: item.body,
      // Announcements restored from an older cache have no format.
      bodyFormat: item.bodyFormat ?? 'plain',
      bodyCss: item.bodyCss ?? '',
      startsAt: Date.parse(item.startsAt),
    }));
  const engineResult = resolvePlayback(manifest.defaultPlaylistId, manifest.rules as PlaybackRule[], {
    now: new Date(now),
    printingMachineIds: available ? machines.filter(isPrinting).map((machine) => machine.machineId) : [],
    activeAnnouncementTemplateIds: announcements.map((item) => item.templateId),
    liveDataAvailable: available,
  });
  const { hold, result } = holdResult(input.hold, engineResult, now);

  let scene: SignagePlayerScene | null = null;
  let transition: SignageTransition = 'cut';
  let sceneKey = result.target.id;
  if (result.target.kind === 'scene') {
    scene = manifest.scenes.find((item) => item.id === result.target.id) ?? null;
  } else {
    const playlist = manifest.playlists.find((item) => item.id === result.target.id);
    const items = (playlist?.items ?? []).filter((item) => manifest.scenes.some((entry) => entry.id === item.sceneId));
    const current = playlistPosition(items, (now - hold.since) / 1000);
    if (current) {
      scene = manifest.scenes.find((item) => item.id === current.item.sceneId) ?? null;
      transition = current.item.transition;
      sceneKey = `${result.target.id}:${current.index}`;
    }
  }
  const data: RenderData = {
    now,
    liveAvailable: available,
    machines,
    unavailableCameras: new Set(
      machines.filter((machine) => !camera.hasStream(machine.machineId)).map((machine) => machine.machineId),
    ),
    announcements,
    openDays: live?.openDays ?? [],
    events: live?.events ?? [],
    calendar: live?.calendar ?? null,
    // A manifest cached before custom layouts has none.
    customLayouts: manifest.customLayouts ?? [],
    assetUrl: input.assetUrl,
    assetName: input.assetName,
    multiMode: result.multiMode,
    alternateSeconds: result.alternateSeconds,
    cameraView: (machine) => camera.view(machine),
  };
  return { view: { scene, data, transition, sceneKey, ruleId: result.ruleId, sceneId: scene?.id ?? null }, hold };
}
