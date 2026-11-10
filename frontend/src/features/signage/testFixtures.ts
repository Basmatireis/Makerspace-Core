import { http, HttpResponse } from 'msw';
import type {
  PermissionId,
  SignageAnnouncement,
  SignageAnnouncementTemplate,
  SignageAsset,
  SignageCalendar,
  SignageDisplay,
  SignageDisplayGroup,
  SignageDisplayPreview,
  SignageMachine,
  SignageBlock,
  SignageBlockStyle,
  SignageRule,
  SignageScene,
  SignageWidget,
  SignageWebEmbed,
} from '../../api/generated/models';
import { currentUserFixture } from '../../test/fixtures';
import { server } from '../../test/server';
import { defaultBlockStyle } from './widgets';

export const ids = {
  scene: '0192f6f8-743e-7c77-a349-cd07c3e8a111',
  scene2: '0192f6f8-743e-7c77-a349-cd07c3e8a112',
  template: '0192f6f8-743e-7c77-a349-cd07c3e8a131',
  asset: '0192f6f8-743e-7c77-a349-cd07c3e8a141',
  video: '0192f6f8-743e-7c77-a349-cd07c3e8a142',
  display: '0192f6f8-743e-7c77-a349-cd07c3e8a151',
  announcement: '0192f6f8-743e-7c77-a349-cd07c3e8a161',
  group: '0192f6f8-743e-7c77-a349-cd07c3e8a1b1',
  rule: '0192f6f8-743e-7c77-a349-cd07c3e8a171',
  rule2: '0192f6f8-743e-7c77-a349-cd07c3e8a172',
  machine: '0192f6f8-743e-7c77-a349-cd07c3e8a181',
  embed: '0192f6f8-743e-7c77-a349-cd07c3e8a1c1',
};
const stamp = '2026-10-19T08:00:00Z';

/** A visible, unlocked block with the default style of its widget (patched by `style`). */
export const blockFixture = (
  id: string,
  rect: Pick<SignageBlock, 'x' | 'y' | 'w' | 'h'>,
  widget: SignageWidget,
  style: Partial<SignageBlockStyle> = {},
): SignageBlock => ({
  id,
  name: id,
  ...rect,
  hidden: false,
  locked: false,
  widget,
  style: { ...defaultBlockStyle(widget.type), ...style },
});

export const sceneFixture = (overrides: Partial<SignageScene> = {}): SignageScene => ({
  id: ids.scene,
  name: 'Open days poster',
  aspectRatio: { width: 9, height: 16 },
  backgroundColor: '#161616',
  backgroundAssetId: null,
  backgroundFit: 'cover',
  backgroundDim: 30,
  fontFamily: 'sans',
  fontAssetId: null,
  theme: 'dark',
  blocks: [
    blockFixture(
      'header',
      { x: 0, y: 0, w: 1080, h: 384 },
      { type: 'text', text: 'Welcome', fit: false },
      {
        textSize: 76,
        align: 'center',
      },
    ),
    blockFixture(
      'main',
      { x: 0, y: 384, w: 1080, h: 1152 },
      { type: 'image', mediaId: ids.asset, fit: 'cover', dim: 0 },
    ),
    blockFixture('footer', { x: 0, y: 1536, w: 1080, h: 384 }, { type: 'empty' }),
  ],
  version: 3,
  createdAt: stamp,
  updatedAt: stamp,
  ...overrides,
});

export const templateFixture = (overrides: Partial<SignageAnnouncementTemplate> = {}): SignageAnnouncementTemplate => ({
  id: ids.template,
  name: 'Closed',
  tone: 'warning',
  title: 'Closed today – {reason}',
  body: 'We are back {ends}.',
  bodyFormat: 'plain',
  bodyCss: '',
  fields: [
    {
      key: 'reason',
      label: 'Reason',
      type: 'choice',
      required: true,
      defaultValue: '',
      helperText: '',
      options: ['Holiday', 'Maintenance'],
    },
  ],
  version: 4,
  createdAt: stamp,
  updatedAt: stamp,
  ...overrides,
});

export const assetFixture = (overrides: Partial<SignageAsset> = {}): SignageAsset => ({
  id: ids.asset,
  kind: 'image',
  name: 'poster.png',
  width: 1080,
  height: 1920,
  durationMs: null,
  contentType: 'image/png',
  sizeBytes: 2_097_152,
  sha256: 'a'.repeat(64),
  createdByName: 'Ada Lovelace',
  createdAt: stamp,
  ...overrides,
});

export const announcementFixture = (overrides: Partial<SignageAnnouncement> = {}): SignageAnnouncement => ({
  id: ids.announcement,
  templateId: ids.template,
  values: { reason: 'Holiday' },
  allDisplays: true,
  displayIds: [],
  groupIds: [],
  startsAt: stamp,
  endsAt: null,
  status: 'active',
  rendered: { title: 'Closed today – Holiday', body: '', bodyFormat: 'plain', bodyCss: '', tone: 'warning' },
  version: 1,
  createdAt: stamp,
  updatedAt: stamp,
  ...overrides,
});

export const displayFixture = (overrides: Partial<SignageDisplay> = {}): SignageDisplay => ({
  id: ids.display,
  managedDeviceId: '0192f6f8-743e-7c77-a349-cd07c3e8a191',
  groupId: null,
  name: 'Entrance window',
  location: 'Ground floor',
  aspectRatio: { width: 9, height: 16 },
  visibleFromOutside: true,
  allowCameraOutside: false,
  defaultScenes: [{ sceneId: ids.scene, seconds: 20, transition: 'fade' }],
  status: 'online',
  revokedAt: null,
  lastHeartbeatAt: new Date().toISOString(),
  publishedRevision: 2,
  publishedAt: stamp,
  pendingChanges: [],
  reportedRevision: 2,
  currentRule: 'default',
  currentSceneId: ids.scene,
  playerVersion: '1.0.0',
  cacheUsedBytes: 1_073_741_824,
  cacheQuotaBytes: 8_589_934_592,
  errors: [],
  version: 5,
  createdAt: stamp,
  updatedAt: stamp,
  ...overrides,
});

export const embedFixture = (overrides: Partial<SignageWebEmbed> = {}): SignageWebEmbed => ({
  id: ids.embed,
  name: 'Open days on the student council site',
  aspectRatio: { width: 16, height: 9 },
  groupId: null,
  defaultScenes: [{ sceneId: ids.scene, seconds: 20, transition: 'fade' }],
  embedKey: 'k7Hq2pX9wLm4k7Hq2pX9wLm4k7Hq2pX9',
  embedUrl: 'https://core.example/embed/k7Hq2pX9wLm4k7Hq2pX9wLm4k7Hq2pX9',
  allowedOrigins: ['https://fachschaft-muster.example', 'https://www.fachschaft-muster.example'],
  openDirectly: false,
  enabled: true,
  cameraEnabled: false,
  cameraMachineIds: [],
  cameraViewerLimit: 10,
  timelapseEnabled: false,
  timelapseCount: 5,
  timelapseMaxAgeDays: 14,
  publishedRevision: 4,
  publishedAt: stamp,
  pendingChanges: [],
  hasUnpublishedChanges: false,
  lastLoadedAt: new Date(Date.now() - 3 * 60_000).toISOString(),
  loadsToday: 212,
  version: 3,
  createdAt: stamp,
  updatedAt: stamp,
  ...overrides,
});

export const groupFixture = (overrides: Partial<SignageDisplayGroup> = {}): SignageDisplayGroup => ({
  id: ids.group,
  name: 'Hallway screens',
  aspectRatio: { width: 9, height: 16 },
  defaultScenes: [{ sceneId: ids.scene, seconds: 20, transition: 'fade' }],
  displayIds: [],
  pendingChanges: [],
  version: 4,
  createdAt: stamp,
  updatedAt: stamp,
  ...overrides,
});

export const ruleFixture = (overrides: Partial<SignageRule> = {}): SignageRule => ({
  id: ids.rule,
  position: 0,
  enabled: true,
  conditionKind: 'time_window',
  weekdays: [1, 2, 3, 4, 5],
  timeFrom: '08:00',
  timeTo: '10:00',
  machineIds: [],
  machineMatch: null,
  announcementTemplateIds: [],
  scenes: [{ sceneId: ids.scene, seconds: 10, transition: 'cut' }],
  minSeconds: 20,
  multiMode: 'split',
  alternateSeconds: 10,
  ...overrides,
});

/** A preview whose publication plays the default scenes (one scene) unless a rule matches. */
export const previewFixture = (overrides: Partial<SignageDisplayPreview> = {}): SignageDisplayPreview => ({
  manifest: {
    revision: 2,
    display: { aspectRatio: { width: 9, height: 16 }, visibleFromOutside: true },
    rules: [],
    manifestVersion: 4,
    defaultScenes: [{ sceneId: ids.scene, seconds: 20, transition: 'fade' }],
    scenes: [{ ...sceneFixture(), version: 3 }],
    assets: [],
  },
  live: {
    serverTime: stamp,
    revision: 2,
    machines: [],
    announcements: [],
    openDays: [],
    events: [],
    calendar: null,
    timelapses: null,
    streams: [],
  },
  ...overrides,
});

type Content = {
  groups?: SignageDisplayGroup[];
  groupRules?: SignageRule[];
  displays?: SignageDisplay[];
  embeds?: SignageWebEmbed[];
  rules?: SignageRule[];
  preview?: SignageDisplayPreview;
  scenes?: SignageScene[];
  templates?: SignageAnnouncementTemplate[];
  assets?: SignageAsset[];
  announcements?: SignageAnnouncement[];
  machines?: SignageMachine[];
  calendar?: SignageCalendar;
};

/** Signed-in user plus read endpoints for the content screens. Individual tests add writes with `server.use`. */
export function mockSignage(permissions: PermissionId[], content: Content = {}) {
  const {
    scenes = [sceneFixture()],
    templates = [templateFixture()],
    assets = [assetFixture()],
    announcements = [],
    machines = [],
    displays = [],
    embeds = [],
    groups = [],
    rules = [],
    groupRules = [],
    preview = previewFixture(),
    calendar = { openDays: [], events: [], calendar: null },
  } = content;
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/signage/scenes', () => HttpResponse.json({ items: scenes })),
    http.get('*/api/v1/signage/scenes/:id', ({ params }) => {
      const scene = scenes.find((item) => item.id === params.id);
      return scene
        ? HttpResponse.json(scene)
        : HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 });
    }),
    http.get('*/api/v1/signage/announcement-templates', () => HttpResponse.json({ items: templates })),
    http.get('*/api/v1/signage/announcements', () => HttpResponse.json({ items: announcements })),
    http.get('*/api/v1/signage/machines', () => HttpResponse.json({ items: machines })),
    http.get('*/api/v1/signage/calendar', () => HttpResponse.json(calendar)),
    http.get('*/api/v1/signage/displays', () => HttpResponse.json({ items: displays })),
    http.get('*/api/v1/signage/displays/:id', ({ params }) => {
      const display = displays.find((item) => item.id === params.id);
      return display
        ? HttpResponse.json(display)
        : HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 });
    }),
    http.get('*/api/v1/signage/displays/:id/rules', ({ params }) =>
      HttpResponse.json({
        items: rules,
        ownerVersion: (embeds.find((item) => item.id === params.id) ?? displays[0])?.version ?? 1,
      }),
    ),
    http.get('*/api/v1/signage/web-embeds', () => HttpResponse.json({ items: embeds })),
    http.get('*/api/v1/signage/web-embeds/:id', ({ params }) => {
      const embed = embeds.find((item) => item.id === params.id);
      return embed
        ? HttpResponse.json(embed)
        : HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 });
    }),
    http.get('*/api/v1/signage/groups', () => HttpResponse.json({ items: groups })),
    http.get('*/api/v1/signage/groups/:id', ({ params }) => {
      const group = groups.find((item) => item.id === params.id);
      return group
        ? HttpResponse.json(group)
        : HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 });
    }),
    http.get('*/api/v1/signage/groups/:id/rules', ({ params }) =>
      HttpResponse.json({
        items: groupRules,
        ownerVersion: groups.find((item) => item.id === params.id)?.version ?? 1,
      }),
    ),
    http.get('*/api/v1/signage/groups/:id/preview', () => HttpResponse.json(preview)),
    http.get('*/api/v1/signage/displays/:id/preview', () => HttpResponse.json(preview)),
    http.get('*/api/v1/signage/assets', () => HttpResponse.json({ items: assets })),
    http.get('*/api/v1/signage/assets/:id/content', () => new HttpResponse(null, { status: 404 })),
  );
}
