import type { CurrentUser } from '../../../api/generated/models';

export type DemoReply = { status: number; body?: unknown };
export type DemoContext<S> = {
  store: S;
  user: CurrentUser;
  params: Record<string, string>;
  query: URLSearchParams;
  /** The parsed JSON request body; an empty object when the request has none. */
  body: Record<string, unknown>;
};
export type DemoHandler<S> = (context: DemoContext<S>) => DemoReply;
type Route<S> = { method: string; pattern: RegExp; names: string[]; handler: DemoHandler<S>; permission?: string };

export const ok = (body: unknown): DemoReply => ({ status: 200, body });
export const created = (body: unknown): DemoReply => ({ status: 201, body });
export const noContent = (): DemoReply => ({ status: 204 });
export const fail = (status: number, code: string, message: string): DemoReply => ({
  status,
  body: { code, message },
});
export const notFound = (what: string) => fail(404, 'not_found', `${what} not found.`);
export const unavailable = (status: number) => fail(status, 'demo_unavailable', 'Not available in demo mode.');

export function paged<T>(items: T[], query: URLSearchParams, extra: Record<string, unknown> = {}) {
  const pageSize = Math.max(1, Number(query.get('pageSize')) || 25);
  const page = Math.max(1, Number(query.get('page')) || 1);
  return { items: items.slice((page - 1) * pageSize, page * pageSize), page, pageSize, total: items.length, ...extra };
}

/** A small method + path-pattern router; the first matching route wins, so literal paths go before `{param}` ones. */
export class DemoRouter<S> {
  private readonly routes: Route<S>[] = [];

  /** `permission` is checked for writes only, and is a UX approximation of what the real API requires. */
  add(method: string, path: string, handler: DemoHandler<S>, permission?: string): this {
    const names: string[] = [];
    const pattern = path.replace(/\.|\{(\w+)\}/g, (match, name: string | undefined) => {
      if (!name) return '\\.';
      names.push(name);
      return '([^/]+)';
    });
    this.routes.push({ method, pattern: new RegExp(`^${pattern}$`), names, handler, permission });
    return this;
  }

  get(path: string, handler: DemoHandler<S>): this {
    return this.add('GET', path, handler);
  }

  match(method: string, path: string) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const found = route.pattern.exec(path);
      if (!found) continue;
      const params: Record<string, string> = {};
      route.names.forEach((name, index) => {
        params[name] = decodeURIComponent(found[index + 1]);
      });
      return { route, params };
    }
    return null;
  }
}

export function toResponse(reply: DemoReply): Response {
  if (reply.status === 204 || reply.body === undefined) return new Response(null, { status: reply.status });
  return new Response(JSON.stringify(reply.body), {
    status: reply.status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Runs one request against the router; routes without a handler answer with the demo envelope. */
export function dispatch<S>(
  router: DemoRouter<S>,
  store: S,
  user: CurrentUser,
  url: string,
  init: RequestInit,
): DemoReply {
  const method = (init.method ?? 'GET').toUpperCase();
  const { pathname, searchParams } = new URL(url, 'http://demo.invalid');
  const path = pathname.replace(/^\/api\/v1/, '') || '/';
  const matched = router.match(method, path);
  if (!matched) return unavailable(method === 'GET' || method === 'HEAD' ? 404 : 409);
  const { route, params } = matched;
  if (method !== 'GET' && route.permission && !user.permissions.includes(route.permission as never)) {
    return fail(403, 'forbidden', 'You do not have permission to do this.');
  }
  let body: Record<string, unknown> = {};
  if (typeof init.body === 'string' && init.body) {
    try {
      body = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return fail(400, 'invalid_request', 'The request body is not valid JSON.');
    }
  }
  return route.handler({ store, user, params, query: searchParams, body });
}
