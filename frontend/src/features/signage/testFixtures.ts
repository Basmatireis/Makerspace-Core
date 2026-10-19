import { http, HttpResponse } from 'msw';
import type { PermissionId, SignageAnnouncement, SignageAnnouncementTemplate, SignageAsset, SignageMachine, SignagePlaylist, SignageScene } from '../../api/generated/models';
import { currentUserFixture } from '../../test/fixtures';
import { server } from '../../test/server';

export const ids = {
  scene: '0192f6f8-743e-7c77-a349-cd07c3e8a111',
  scene2: '0192f6f8-743e-7c77-a349-cd07c3e8a112',
  playlist: '0192f6f8-743e-7c77-a349-cd07c3e8a121',
  template: '0192f6f8-743e-7c77-a349-cd07c3e8a131',
  asset: '0192f6f8-743e-7c77-a349-cd07c3e8a141',
  video: '0192f6f8-743e-7c77-a349-cd07c3e8a142',
  display: '0192f6f8-743e-7c77-a349-cd07c3e8a151',
  announcement: '0192f6f8-743e-7c77-a349-cd07c3e8a161',
};
const stamp = '2026-10-19T08:00:00Z';

export const sceneFixture = (overrides: Partial<SignageScene> = {}): SignageScene => ({
  id: ids.scene, name: 'Open days poster', orientation: 'portrait', layoutId: 'stack3', backgroundColor: '#161616', backgroundAssetId: null, backgroundFit: 'cover', backgroundDim: 30, theme: 'dark',
  zones: { header: { type: 'text', text: 'Welcome', size: 'l', align: 'center' }, main: { type: 'image', mediaId: ids.asset, fit: 'cover' }, footer: { type: 'empty' } },
  version: 3, createdAt: stamp, updatedAt: stamp, ...overrides,
});

export const playlistFixture = (overrides: Partial<SignagePlaylist> = {}): SignagePlaylist => ({
  id: ids.playlist, name: 'Ads', items: [{ sceneId: ids.scene, seconds: 20, transition: 'fade' }], version: 2, createdAt: stamp, updatedAt: stamp, ...overrides,
});

export const templateFixture = (overrides: Partial<SignageAnnouncementTemplate> = {}): SignageAnnouncementTemplate => ({
  id: ids.template, name: 'Closed', tone: 'warning', title: 'Closed today – {reason}', body: 'We are back {ends}.',
  fields: [{ key: 'reason', label: 'Reason', type: 'choice', required: true, defaultValue: '', helperText: '', options: ['Holiday', 'Maintenance'] }],
  version: 4, createdAt: stamp, updatedAt: stamp, ...overrides,
});

export const assetFixture = (overrides: Partial<SignageAsset> = {}): SignageAsset => ({
  id: ids.asset, kind: 'image', name: 'poster.png', width: 1080, height: 1920, durationMs: null, contentType: 'image/png', sizeBytes: 2_097_152, sha256: 'a'.repeat(64), createdByName: 'Ada Lovelace', createdAt: stamp, ...overrides,
});

export const announcementFixture = (overrides: Partial<SignageAnnouncement> = {}): SignageAnnouncement => ({
  id: ids.announcement, templateId: ids.template, values: { reason: 'Holiday' }, allDisplays: true, displayIds: [], startsAt: stamp, endsAt: null, status: 'active',
  rendered: { title: 'Closed today – Holiday', body: '', tone: 'warning' }, version: 1, createdAt: stamp, updatedAt: stamp, ...overrides,
});

type Content = { scenes?: SignageScene[]; playlists?: SignagePlaylist[]; templates?: SignageAnnouncementTemplate[]; assets?: SignageAsset[]; announcements?: SignageAnnouncement[]; machines?: SignageMachine[] };

/** Signed-in user plus read endpoints for the content screens. Individual tests add writes with `server.use`. */
export function mockSignage(permissions: PermissionId[], content: Content = {}) {
  const { scenes = [sceneFixture()], playlists = [playlistFixture()], templates = [templateFixture()], assets = [assetFixture()], announcements = [], machines = [] } = content;
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/signage/scenes', () => HttpResponse.json({ items: scenes })),
    http.get('*/api/v1/signage/scenes/:id', ({ params }) => {
      const scene = scenes.find((item) => item.id === params.id);
      return scene ? HttpResponse.json(scene) : HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 });
    }),
    http.get('*/api/v1/signage/playlists', () => HttpResponse.json({ items: playlists })),
    http.get('*/api/v1/signage/playlists/:id', ({ params }) => {
      const playlist = playlists.find((item) => item.id === params.id);
      return playlist ? HttpResponse.json(playlist) : HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 });
    }),
    http.get('*/api/v1/signage/announcement-templates', () => HttpResponse.json({ items: templates })),
    http.get('*/api/v1/signage/announcements', () => HttpResponse.json({ items: announcements })),
    http.get('*/api/v1/signage/machines', () => HttpResponse.json({ items: machines })),
    http.get('*/api/v1/signage/assets', () => HttpResponse.json({ items: assets })),
    http.get('*/api/v1/signage/assets/:id/content', () => new HttpResponse(null, { status: 404 })),
  );
}
