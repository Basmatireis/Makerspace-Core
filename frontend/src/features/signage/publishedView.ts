import type {
  SignageDisplayPreview,
  SignageRule,
  SignagePlayerManifest,
  SignagePlayerScene,
  SignageTransition,
} from '../../api/generated/models';
import { assetContentUrl, timelapseContentUrl } from './preview';
import {
  sceneListPosition,
  resolvePlayback,
  type Names,
  type PlaybackResult,
  type PlaybackRule,
} from './engine/playback';
import { isPrinting, type RenderAnnouncement, type RenderData, type RenderMachine } from './render/types';

/** What a display runs right now according to its latest publication, live machine states and active announcements. */
export type PublishedView = {
  manifest: SignagePlayerManifest;
  result: PlaybackResult;
  /** Scene on screen now (the current item of the winning scene list). */
  scene: SignagePlayerScene | null;
  transition: SignageTransition;
  /** Changes when another list item takes over, so a fade can restart. */
  itemKey: string;
  secondsLeft: number | null;
  data: RenderData;
};

export type PublishedOptions = {
  now: number;
  timeZone: string;
  /** Announcements that would be in force in addition to the live ones (the start dialog's draft). */
  extra?: readonly RenderAnnouncement[];
  /** A live announcement to leave out (the one being edited). */
  omitAnnouncementId?: string;
  names?: Names;
};

export function renderMachinesOf(preview: SignageDisplayPreview): RenderMachine[] {
  return preview.live.machines.map((machine) => ({
    machineId: machine.machineId,
    name: machine.name,
    state: machine.state,
    progressPercent: machine.progressPercent,
    remainingMinutes: machine.remainingMinutes,
    stale: machine.stale,
  }));
}

/** Runs the shared playback engine on the published manifest; null before the first publication. */
export function resolvePublished(preview: SignageDisplayPreview, options: PublishedOptions): PublishedView | null {
  const manifest = preview.manifest;
  if (!manifest) return null;
  const { now, timeZone, extra = [], omitAnnouncementId, names } = options;
  const machines = renderMachinesOf(preview);
  const announcements: RenderAnnouncement[] = [
    ...preview.live.announcements
      .filter((item) => item.id !== omitAnnouncementId)
      .map((item) => ({
        id: item.id,
        templateId: item.templateId,
        tone: item.tone,
        title: item.title,
        body: item.body,
        bodyFormat: item.bodyFormat,
        bodyCss: item.bodyCss,
        startsAt: Date.parse(item.startsAt),
      })),
    ...extra,
  ];
  const digests = new Map(manifest.assets.map((asset) => [asset.id, asset.sha256]));
  const assetNames = new Map(manifest.assets.map((asset) => [asset.id, asset.name]));
  const result = resolvePlayback(
    manifest.defaultScenes,
    manifest.rules as PlaybackRule[],
    {
      now: new Date(now),
      printingMachineIds: machines.filter(isPrinting).map((machine) => machine.machineId),
      activeAnnouncementTemplateIds: announcements.map((item) => item.templateId),
      liveDataAvailable: true,
    },
    names,
  );
  const data: RenderData = {
    now,
    liveAvailable: true,
    machines,
    announcements,
    openDays: preview.live.openDays,
    events: preview.live.events,
    calendar: preview.live.calendar,
    timelapses: preview.live.timelapses,
    timelapseUrl: (clip) => timelapseContentUrl(clip.runId, clip.sha256),
    timeZone,
    multiMode: result.multiMode,
    alternateSeconds: result.alternateSeconds,
    assetUrl: (assetId) => (digests.has(assetId) ? assetContentUrl(assetId, digests.get(assetId)) : null),
    assetName: (assetId) => assetNames.get(assetId) ?? null,
  };
  let scene: SignagePlayerScene | null = null;
  let transition: SignageTransition = 'cut';
  let itemKey = result.ruleId;
  let secondsLeft: number | null = null;
  // Items whose scene is missing from the manifest are skipped.
  const items = result.scenes.filter((item) => manifest.scenes.some((entry) => entry.id === item.sceneId));
  const current = sceneListPosition(items, now / 1000);
  if (current) {
    scene = manifest.scenes.find((item) => item.id === current.item.sceneId) ?? null;
    transition = current.item.transition;
    itemKey = `${result.ruleId}-${current.index}`;
    // A single scene never changes, so there is no countdown.
    secondsLeft = items.length > 1 ? current.secondsLeft : null;
  }
  return {
    manifest,
    result,
    scene,
    transition,
    itemKey,
    secondsLeft,
    data,
  };
}

/** An admin rule in the shape the engine reads (the API calls the condition `conditionKind`). */
export const toPlaybackRule = (rule: SignageRule): PlaybackRule => ({
  id: rule.id,
  enabled: rule.enabled,
  kind: rule.conditionKind,
  weekdays: rule.weekdays,
  timeFrom: rule.timeFrom,
  timeTo: rule.timeTo,
  machineIds: rule.machineIds,
  machineMatch: rule.machineMatch,
  announcementTemplateIds: rule.announcementTemplateIds,
  scenes: rule.scenes,
  minSeconds: rule.minSeconds,
  multiMode: rule.multiMode,
  alternateSeconds: rule.alternateSeconds,
});
