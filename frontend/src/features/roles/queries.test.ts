import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../../test/server';
import { testQueryClient } from '../../test/render';
import { fullRoleCatalogOptions } from './queries';

function role(id: string, name: string) {
  return {
    id,
    name,
    description: null,
    systemKey: null,
    permissionIds: [],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    version: 1,
  };
}

describe('full role catalog query', () => {
  it('loads every cursor page for account role management', async () => {
    const requests: string[] = [];
    server.use(
      http.get('*/api/v1/roles', ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('cursor');
        requests.push(cursor ?? 'first');
        return HttpResponse.json(
          cursor
            ? {
                items: [role('0192f6f8-743e-7c77-a349-cd07c3e8a905', 'Second')],
                nextCursor: null,
              }
            : {
                items: [role('0192f6f8-743e-7c77-a349-cd07c3e8a904', 'First')],
                nextCursor: 'next-page',
              },
        );
      }),
    );

    const queryClient = testQueryClient();
    const roles = await queryClient.fetchQuery(fullRoleCatalogOptions);

    expect(requests).toEqual(['first', 'next-page']);
    expect(roles.map(({ name }) => name)).toEqual(['First', 'Second']);
  });
});
