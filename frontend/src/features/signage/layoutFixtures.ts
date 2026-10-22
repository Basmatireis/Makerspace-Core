import { http, HttpResponse } from 'msw';
import type { SignageCustomLayout } from '../../api/generated/models';
import { server } from '../../test/server';

export const layoutIds = {
  grid: '0192f6f8-743e-7c77-a349-cd07c3e8b001',
  free: '0192f6f8-743e-7c77-a349-cd07c3e8b002',
};
const stamp = '2026-10-22T08:00:00Z';

export const gridLayoutFixture = (overrides: Partial<SignageCustomLayout> = {}): SignageCustomLayout => ({
  id: layoutIds.grid,
  name: 'Poster with side',
  mode: 'grid',
  columns: [2, 1],
  rows: [1, 1],
  zones: [
    { id: 'z1', label: 'Poster', grid: { col: 1, row: 1, colSpan: 1, rowSpan: 2 }, rect: null },
    { id: 'z2', label: 'Top side', grid: { col: 2, row: 1, colSpan: 1, rowSpan: 1 }, rect: null },
    { id: 'z3', label: 'Bottom side', grid: { col: 2, row: 2, colSpan: 1, rowSpan: 1 }, rect: null },
  ],
  sceneCount: 0,
  version: 2,
  createdAt: stamp,
  updatedAt: stamp,
  ...overrides,
});

export const freeLayoutFixture = (overrides: Partial<SignageCustomLayout> = {}): SignageCustomLayout => ({
  id: layoutIds.free,
  name: 'Floating clock',
  mode: 'free',
  columns: [1],
  rows: [1],
  zones: [
    { id: 'z1', label: 'Background', grid: null, rect: { x: 0, y: 0, width: 100, height: 100 } },
    { id: 'z2', label: 'Clock', grid: null, rect: { x: 60, y: 5, width: 35, height: 15 } },
  ],
  sceneCount: 0,
  version: 1,
  createdAt: stamp,
  updatedAt: stamp,
  ...overrides,
});

/** Read endpoints for custom layouts; tests add writes with `server.use`. */
export function mockCustomLayouts(layouts: SignageCustomLayout[]) {
  server.use(
    http.get('*/api/v1/signage/custom-layouts', () => HttpResponse.json({ items: layouts })),
    http.get('*/api/v1/signage/custom-layouts/:id', ({ params }) => {
      const layout = layouts.find((item) => item.id === params.id);
      return layout
        ? HttpResponse.json(layout)
        : HttpResponse.json({ code: 'not_found', message: 'Not found' }, { status: 404 });
    }),
  );
}
