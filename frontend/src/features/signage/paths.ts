export const signagePaths = {
  displays: '/signage',
  announcements: '/signage/announcements',
  display: (id: string) => `/signage/displays/${encodeURIComponent(id)}`,
  /** The separate player app (phase 3); displays open this address to pair. */
  player: '/player/',
  content: (section?: 'scenes' | 'playlists' | 'announcements' | 'layouts') =>
    section && section !== 'scenes' ? `/signage/content?section=${section}` : '/signage/content',
  scene: (id: string) => `/signage/scenes/${encodeURIComponent(id)}`,
  playlist: (id: string) => `/signage/playlists/${encodeURIComponent(id)}`,
  newLayout: '/signage/layouts/new',
  layout: (id: string) => `/signage/layouts/${encodeURIComponent(id)}`,
  media: '/signage/media',
} as const;
