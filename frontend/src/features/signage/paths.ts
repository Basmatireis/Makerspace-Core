export const signagePaths = {
  displays: '/signage',
  announcements: '/signage/announcements',
  content: (section?: 'scenes' | 'playlists' | 'announcements') => (section && section !== 'scenes' ? `/signage/content?section=${section}` : '/signage/content'),
  scene: (id: string) => `/signage/scenes/${encodeURIComponent(id)}`,
  playlist: (id: string) => `/signage/playlists/${encodeURIComponent(id)}`,
  media: '/signage/media',
} as const;
