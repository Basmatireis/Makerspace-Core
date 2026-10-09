import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const server = setupServer(
	http.post('*/api/v1/auth/activity', () => HttpResponse.json({ idleExpiresAt: '2099-01-01T01:00:00Z', absoluteExpiresAt: '2099-01-02T00:00:00Z', postSessionDestination: 'login' })),
	http.get('*/api/v1/session-policies', () => HttpResponse.json({ items: [] })),
  http.get('*/api/v1/managed-device-types', () => HttpResponse.json({ items: [] })),
  http.get('*/api/v1/permissions', () => HttpResponse.json({ items: [] })),
  http.get('*/api/v1/roles', () => HttpResponse.json({ items: [], nextCursor: null })),
  http.get('*/api/v1/auth/oidc/providers', () => HttpResponse.json({ items: [] })),
  http.get('*/api/v1/auth/me', () =>
    HttpResponse.json(
      { code: 'unauthenticated', message: 'Authentication required' },
      { status: 401 },
    ),
  ),
);
