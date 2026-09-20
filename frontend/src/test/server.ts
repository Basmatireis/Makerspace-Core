import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const server = setupServer(
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
