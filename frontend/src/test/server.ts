import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const server = setupServer(
  http.post('*/api/v1/auth/activity', () =>
    HttpResponse.json({
      idleExpiresAt: '2099-01-01T01:00:00Z',
      absoluteExpiresAt: '2099-01-02T00:00:00Z',
      postSessionDestination: 'login',
    }),
  ),
  // The header bell polls these on every page that renders the application shell.
  http.get('*/api/v1/notifications/unread-count', () => HttpResponse.json({ unreadCount: 0, fresh: [], pinned: [] })),
  // The welcome tour offer asks for guide progress; by default it was already dismissed.
  http.get('*/api/v1/me/guides', () =>
    HttpResponse.json({ items: [{ guideId: 'welcome', status: 'dismissed', updatedAt: '2026-01-01T00:00:00Z' }] }),
  ),
  // The open-day pages ask for the stored list/calendar view; by default nothing is stored.
  http.get('*/api/v1/me/preferences', () => HttpResponse.json({ items: [] })),
  // The rule editor asks for a dry run of every draft; by default there is nothing to show.
  http.post('*/api/v1/notification-rules/dry-run', () =>
    HttpResponse.json({
      estimate30: null,
      estimateNote: '',
      items: [],
      totalItems: 0,
      matchedItems: 0,
      summary: null,
      recipients: [],
      previews: [],
    }),
  ),
  http.get('*/api/v1/session-policies', () => HttpResponse.json({ items: [] })),
  http.get('*/api/v1/managed-device-types', () => HttpResponse.json({ items: [] })),
  http.get('*/api/v1/permissions', () => HttpResponse.json({ items: [] })),
  http.get('*/api/v1/roles', () => HttpResponse.json({ items: [], nextCursor: null })),
  http.get('*/api/v1/auth/second-factors', () =>
    HttpResponse.json({ enrolled: false, totp: null, passkeys: [], recoveryCodesRemaining: 0 }),
  ),
  http.get('*/api/v1/auth/oidc/providers', () => HttpResponse.json({ items: [] })),
  http.get('*/api/v1/auth/me', () =>
    HttpResponse.json({ code: 'unauthenticated', message: 'Authentication required' }, { status: 401 }),
  ),
);
