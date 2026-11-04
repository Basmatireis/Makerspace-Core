import type { CurrentUser } from '../../../api/generated/models';
import type { ApiTransport } from '../../../api/http-client';
import { registerInventory } from './handlers/inventory';
import { registerOpenDays } from './handlers/openDays';
import { registerSales } from './handlers/sales';
import { registerShell } from './handlers/shell';
import { registerWorkshop } from './handlers/workshop';
import { DemoRouter, dispatch, toResponse } from './router';
import { createStore } from './seed';
import type { DemoStore } from './store';

// Branding and legal pages are public and read-only; they keep coming from the real server so the demo looks like
// the installation it runs in. Only GET may take this way out.
const PASS_THROUGH = /^\/api\/v1\/public\/(config|legal\/|branding\/assets\/)/;

export function buildRouter(): DemoRouter<DemoStore> {
  const router = new DemoRouter<DemoStore>();
  registerShell(router);
  registerOpenDays(router);
  registerWorkshop(router);
  registerInventory(router);
  registerSales(router);
  return router;
}

/** The fake backend for one demo session: its transport and the in-memory store the transport serves. */
export function createDemoBackend(user: CurrentUser, now?: Date): { transport: ApiTransport; store: DemoStore } {
  const store = createStore(user, now);
  const router = buildRouter();
  const transport: ApiTransport = (url, init) => {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'GET' && PASS_THROUGH.test(new URL(url, 'http://demo.invalid').pathname)) return fetch(url, init);
    return Promise.resolve(toResponse(dispatch(router, store, user, url, init)));
  };
  return { transport, store };
}

export function createDemoTransport(user: CurrentUser): ApiTransport {
  return createDemoBackend(user).transport;
}
