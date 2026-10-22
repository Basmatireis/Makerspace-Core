import vectorFile from '../../../../../api/testdata/signage-announcement-render.json';
import { describe, expect, it } from 'vitest';
import {
  escapeForFormat,
  fieldKeyFor,
  placeholdersIn,
  renderAnnouncement,
  unknownPlaceholders,
  type EngineTemplate,
} from './announcements';

type Vector = {
  name: string;
  template: {
    fields: { key: string; type: EngineTemplate['fields'][number]['type'] }[];
    title: string;
    body: string;
    bodyFormat?: EngineTemplate['bodyFormat'];
    tone: EngineTemplate['tone'];
  };
  values: Record<string, string>;
  startsAt: string;
  endsAt: string | null;
  now: string;
  timeZone: string;
  displayName: string;
  location: string;
  machines: Record<string, string>;
  expected: { title: string; body: string; tone: string };
};

// The same file the Go renderer runs (backend/internal/signage/render_test.go).
const vectors = vectorFile as unknown as { cases: Vector[] };

describe('shared announcement render vectors', () => {
  it('contains the full vector set', () => expect(vectors.cases.length).toBeGreaterThanOrEqual(15));
  it.each(vectors.cases.map((vector) => [vector.name, vector] as const))('%s', (_name, vector) => {
    const result = renderAnnouncement(
      vector.template,
      vector.values,
      { startsAt: new Date(vector.startsAt), endsAt: vector.endsAt ? new Date(vector.endsAt) : null },
      {
        now: new Date(vector.now),
        timeZone: vector.timeZone,
        displayName: vector.displayName,
        location: vector.location,
        machines: vector.machines,
      },
    );
    expect({ title: result.title, body: result.body, tone: result.tone }).toEqual(vector.expected);
    expect(result.bodyFormat).toBe(vector.template.bodyFormat ?? 'plain');
  });
});

describe('does not resolve inherited object keys', () => {
  it('keeps {constructor} as typed', () => {
    const template: EngineTemplate = { fields: [], title: '{constructor}', body: '', tone: 'info' };
    const result = renderAnnouncement(
      template,
      {},
      { startsAt: new Date(0), endsAt: null },
      { now: new Date(0), timeZone: 'UTC', displayName: '', location: '', machines: {} },
    );
    expect(result.title).toBe('{constructor}');
  });
});

describe('template helpers', () => {
  it('lists placeholders in order', () => expect(placeholdersIn('{a} x {b_1} {a}')).toEqual(['a', 'b_1', 'a']));
  it('flags placeholders that are neither fields nor built-ins, sorted and unique', () => {
    expect(
      unknownPlaceholders({ fields: [{ key: 'reason' }], title: '{reason} {ends} {oops}', body: '{oops} {other}' }),
    ).toEqual(['oops', 'other']);
  });
  it('derives unique field keys that never collide with built-ins and match the backend pattern', () => {
    expect(fieldKeyFor('Back on', [])).toBe('back_on');
    expect(fieldKeyFor('Back on', ['back_on'])).toBe('back_on_2');
    expect(fieldKeyFor('Ends', [])).toBe('ends_2');
    expect(fieldKeyFor('  ', [])).toBe('field');
    expect(fieldKeyFor('2nd floor', [])).toBe('nd_floor');
    expect(fieldKeyFor('x'.repeat(80), [])).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
  });
});

describe('placeholder escaping per body format', () => {
  it('escapes html values', () => {
    expect(escapeForFormat('html')(`<b>"Tom" & 'Jerry'</b>`)).toBe(
      '&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;',
    );
  });
  it('backslash-escapes markdown punctuation and entity-escapes markup', () => {
    expect(escapeForFormat('markdown')('# a*b* [x](y) <i> & 1. a_b: c|d~e=f')).toBe(
      '\\# a\\*b\\* \\[x\\]\\(y\\) &lt;i&gt; &amp; 1\\. a\\_b\\: c\\|d\\~e\\=f',
    );
  });
  it('keeps plain values as typed', () => {
    expect(escapeForFormat('plain')('<b>*x*</b>')).toBe('<b>*x*</b>');
    expect(escapeForFormat(undefined)('&')).toBe('&');
  });
});
