import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';

export const server = setupServer(
  http.get('*/api/v1/managed-device-types', () => HttpResponse.json({ items: [] })),
  http.get('*/api/v1/auth/me', () =>
    HttpResponse.json(
      { code: 'unauthenticated', message: 'Authentication required' },
      { status: 401 },
    ),
  ),
);
