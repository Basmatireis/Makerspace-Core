import { expect, type Page, type Route } from '@playwright/test';
import { defaultPublicBrandingConfiguration } from './branding-fixtures';
import { welcomeTourSeen } from './guide-progress';
import { currentUser, ids, timestamp } from './open-days-api';

/**
 * A mocked PDF templates API for the browser tests: every operation of the `pdf-templates` tag answers from one small
 * world, so a saved draft is visible in the next response. The preview renders a real (tiny) PDF and reports boxes for the
 * blocks of the posted document, so the page overlay has something to select and move. Anything the world does not know
 * answers 501 and is recorded in `unexpected`.
 */

type Kind = 'wiref' | 'cashbook' | 'receipt';
type Doc = Record<string, unknown> & { layers: Block[]; header: Block[]; body: Block[]; footer: Block[] };
type Block = Record<string, unknown> & { id: string; type: string; elements?: Block[] };
type Version = {
  id: string;
  version: number;
  state: 'draft' | 'published' | 'archived';
  revision: number;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string | null;
  createdBy?: string | null;
  publishedBy?: string | null;
  document: Doc;
};
export type Recorded = { method: string; path: string; search: string; body: unknown };
export type World = {
  permissions: string[];
  draft: Version | null;
  published: Version | null;
  versions: Version[];
  requests: Recorded[];
  unexpected: string[];
  /** Makes the preview answer with an error (the editor must stay usable). */
  previewFails: boolean;
};

const nodeId = (suffix: string) => `0192f6f8-743e-7c77-a349-cd07c3e8c${suffix}`;

/** The built-in default the mock serves: a title, an introduction and a table in the body, a stamp on a page layer. */
export function builtinDocument(kind: Kind = 'wiref'): Doc {
  return {
    schemaVersion: 1,
    name: kind === 'wiref' ? 'wiRef invoice request' : kind === 'cashbook' ? 'Cashbook' : 'Order receipt',
    export: kind,
    page: {
      size: 'A4',
      orientation: 'portrait',
      margins: [30, 20, 22, 20],
      font: 'IBM Plex Sans',
      baseSize: 10,
      accent: '#0f62fe',
      locale: 'en',
      accentBar: true,
      filename: 'invoice-request-{{request.number}}.pdf',
    },
    styles: {
      colors: [
        { id: 'text', name: 'Text', value: '#161616' },
        { id: 'red', name: 'HTU red', value: '#d0103a' },
      ],
      text: [
        { id: 'body', name: 'Body', font: 'IBM Plex Sans', size: 10, weight: 400, lineHeight: 1.4, color: '$c:text' },
      ],
      sizes: [],
    },
    layers: [
      {
        id: 'stampLayer',
        type: 'layer',
        title: 'Stamps',
        pages: 'first',
        elements: [{ id: 'stamp', type: 'rect', x: 150, y: 20, w: 40, h: 12, stroke: 0.3, color: '#161616' }],
      },
    ],
    header: [{ id: 'logo', type: 'image', height: 12 }],
    body: [
      { id: 'title', type: 'heading', title: 'Document title', text: 'Invoice request {{request.number}}', size: 17 },
      {
        id: 'intro',
        type: 'text',
        title: 'Introduction',
        text: 'Please issue an invoice to the recipient below.',
        textStyle: 'body',
      },
      {
        id: 'items',
        type: 'table',
        title: 'Invoiced items',
        source: 'items',
        as: 'item',
        repeatHeader: true,
        columns: [{ header: 'Description', value: '{{item.description}}', width: 100, align: 'left' }],
        totals: [],
      },
    ],
    footer: [{ id: 'pageno', type: 'text', title: 'Page number', text: 'Page {{page}} / {{pages}}', size: 8 }],
  };
}

const schema = {
  groups: [
    {
      name: 'Request',
      fields: [{ path: 'request.number', type: 'text', description: 'The request number.', example: 'IR-2026-0042' }],
    },
    {
      name: 'Items',
      list: 'items',
      fields: [{ path: 'items[].description', type: 'text', description: 'What was sold.' }],
    },
  ],
  filters: [{ name: 'currency', description: 'Formats an amount with the currency.' }],
};

export function newWorld(overrides: Partial<World> = {}): World {
  return {
    permissions: ['pdf_templates.manage'],
    draft: null,
    published: null,
    versions: [],
    requests: [],
    unexpected: [],
    previewFails: false,
    ...overrides,
  };
}

export function versionOf(version: number, state: Version['state'], document: Doc, revision = 1): Version {
  return {
    id: nodeId(String(100 + version)),
    version,
    state,
    revision,
    createdAt: timestamp,
    updatedAt: timestamp,
    publishedAt: state === 'published' ? timestamp : null,
    createdBy: 'Ada Lovelace',
    publishedBy: state === 'published' ? 'Ada Lovelace' : null,
    document,
  };
}

/** A one-page PDF with a line of text, with correct cross-reference offsets. */
export function tinyPdfBase64(): string {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '', // the content stream, below
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  const stream = 'BT /F1 14 Tf 57 760 Td (Invoice request IR-2026-0042) Tj ET';
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) out += `${String(offset).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1').toString('base64');
}

/** Boxes of the posted document: flow blocks are stacked in their bands, layer elements sit at their own x/y/w/h. */
export function boxesOf(doc: Doc) {
  const boxes: { nodeId: string; page: number; x: number; y: number; w: number; h: number }[] = [];
  const stack = (blocks: Block[], y0: number, height: number) =>
    blocks.forEach((block, i) =>
      boxes.push({ nodeId: block.id, page: 1, x: 20, y: y0 + i * (height + 2), w: 170, h: height }),
    );
  stack(doc.header, 10, 12);
  stack(doc.body, 30, 14);
  stack(doc.footer, 275, 6);
  for (const layer of doc.layers) {
    for (const el of layer.elements ?? []) {
      const e = el as Block & { x?: number; y?: number; w?: number; h?: number };
      boxes.push({ nodeId: e.id, page: 1, x: e.x ?? 20, y: e.y ?? 40, w: e.w ?? 170, h: e.h ?? 10 });
    }
  }
  return boxes;
}

const json = (route: Route, body: unknown, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
const meta = (v: Version | null) => (v ? { ...v, document: undefined } : null);

export async function installPdfTemplatesApi(page: Page, world: World) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname.replace('/api/v1', '');
    const method = request.method();
    const body = method === 'GET' || method === 'DELETE' ? undefined : request.postDataJSON();
    world.requests.push({ method, path, search: url.search, body });

    if (path === '/notifications/unread-count') return json(route, { unreadCount: 0, fresh: [], pinned: [] });
    if (path === '/auth/activity')
      return json(route, {
        idleExpiresAt: '2099-01-01T01:00:00Z',
        absoluteExpiresAt: '2099-01-02T00:00:00Z',
        postSessionDestination: 'login',
      });
    if (path === '/auth/oidc/providers') return json(route, { items: [] });
    if (path === '/public/config') return json(route, defaultPublicBrandingConfiguration());
    if (path === '/auth/me') return json(route, currentUser(world.permissions, 'supervisor'));
    if (path === '/me/guides') return json(route, welcomeTourSeen);
    if (path === '/me/preferences') return json(route, { items: [] });
    if (path === '/me/dashboard')
      return json(route, { person: { firstName: 'Ada', memberSince: '2025-09-01' }, comingUp: [] });

    // PDF templates
    if (path === '/pdf-templates' && method === 'GET')
      return json(
        route,
        (['wiref', 'cashbook', 'receipt'] as Kind[]).map((kind) => ({
          export: kind,
          name: builtinDocument(kind).name,
          published: kind === 'wiref' ? meta(world.published) : null,
          draft: kind === 'wiref' ? meta(world.draft) : null,
        })),
      );
    if (path === '/pdf-templates/assets' && method === 'GET') return json(route, []);
    let match = path.match(/^\/pdf-templates\/(wiref|cashbook|receipt)$/);
    if (match && method === 'GET') {
      const kind = match[1] as Kind;
      return json(route, {
        export: kind,
        draft: kind === 'wiref' ? world.draft : null,
        published: kind === 'wiref' ? world.published : null,
        builtin: builtinDocument(kind),
        schema,
        previewSources: [{ id: 'order-1042', label: 'Invoice request IR-2026-0042' }],
      });
    }
    match = path.match(/^\/pdf-templates\/(wiref|cashbook|receipt)\/versions$/);
    if (match && method === 'GET')
      return json(
        route,
        world.versions.map((v) => meta(v)),
      );
    match = path.match(/^\/pdf-templates\/(wiref|cashbook|receipt)\/versions\/([^/]+)$/);
    if (match && method === 'GET') {
      const found = world.versions.find((v) => v.id === match![2]);
      return found ? json(route, found) : json(route, { code: 'not_found', message: 'Unknown version.' }, 404);
    }
    match = path.match(/^\/pdf-templates\/(wiref|cashbook|receipt)\/versions\/([^/]+)\/restore$/);
    if (match && method === 'POST') {
      const found = world.versions.find((v) => v.id === match![2]);
      if (!found) return json(route, { code: 'not_found', message: 'Unknown version.' }, 404);
      const number = Math.max(0, ...world.versions.map((v) => v.version)) + 1;
      world.draft = versionOf(number, 'draft', found.document);
      world.versions = [world.draft, ...world.versions.filter((v) => v.state !== 'draft')];
      return json(route, world.draft);
    }
    match = path.match(/^\/pdf-templates\/(wiref|cashbook|receipt)\/draft$/);
    if (match && method === 'PUT') {
      const { document } = body as { document: Doc };
      const number = world.draft?.version ?? Math.max(0, ...world.versions.map((v) => v.version)) + 1;
      world.draft = versionOf(number, 'draft', document, (world.draft?.revision ?? 0) + 1);
      world.versions = [world.draft, ...world.versions.filter((v) => v.state !== 'draft')];
      return json(route, { version: world.draft, problems: [] });
    }
    if (match && method === 'DELETE') {
      world.draft = null;
      world.versions = world.versions.filter((v) => v.state !== 'draft');
      return route.fulfill({ status: 204 });
    }
    match = path.match(/^\/pdf-templates\/(wiref|cashbook|receipt)\/publish$/);
    if (match && method === 'POST') {
      if (!world.draft) return json(route, { code: 'no_draft', message: 'There is no draft.' }, 409);
      world.versions = world.versions.map((v) => (v.state === 'published' ? { ...v, state: 'archived' as const } : v));
      world.published = { ...world.draft, state: 'published', publishedAt: timestamp, publishedBy: 'Ada Lovelace' };
      world.versions = world.versions.map((v) => (v.id === world.published!.id ? world.published! : v));
      world.draft = null;
      return json(route, world.published);
    }
    match = path.match(/^\/pdf-templates\/(wiref|cashbook|receipt)\/preview$/);
    if (match && method === 'POST') {
      if (world.previewFails)
        return json(route, { code: 'pdf_render_failed', message: 'The renderer is unavailable.' }, 500);
      const { document } = body as { document: Doc };
      return json(route, {
        pdf: tinyPdfBase64(),
        pages: [{ width: 210, height: 297 }],
        boxes: boxesOf(document),
        problems: [],
        redacted: [],
      });
    }
    if (path === '/pdf-templates/assets' && method === 'POST')
      return json(
        route,
        {
          id: nodeId('900'),
          fileName: 'logo.png',
          contentType: 'image/png',
          byteSize: 3,
          width: 1,
          height: 1,
          createdAt: timestamp,
        },
        201,
      );
    match = path.match(/^\/pdf-templates\/assets\/([^/]+)$/);
    if (match && method === 'GET')
      return route.fulfill({
        status: 200,
        contentType: 'image/png',
        body: Buffer.from('R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==', 'base64'),
      });
    if (match && method === 'DELETE') return route.fulfill({ status: 204 });

    world.unexpected.push(`${method} ${path}`);
    return json(route, { code: 'unexpected_request', message: `${method} ${path}` }, 501);
  });
  return world;
}

export const sent = (world: World, method: string, path: string) =>
  world.requests.filter((r) => r.method === method && r.path === path);

export function expectNoUnexpectedRequests(world: World) {
  expect(world.unexpected).toEqual([]);
}

export { ids };
