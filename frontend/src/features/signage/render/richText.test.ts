import { describe, expect, it } from 'vitest';
import { fillPlaceholders, isAllowedUrl, renderRichText, sanitizeCss, sanitizeHtml } from './richText';

const html = (text: string) => renderRichText({ format: 'html', text }).html;
const markdown = (text: string) => renderRichText({ format: 'markdown', text }).html;

describe('sanitizeHtml', () => {
  it('removes scripts, event handlers and javascript: URLs', () => {
    const out = html(
      '<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:alert(1)">a</a><img src=x onerror="y()">',
    );
    expect(out).toContain('<p>Hi</p>');
    expect(out).not.toMatch(/script|onclick|onerror|javascript:/i);
  });

  it('removes frames, objects, forms, form controls, link, meta and base', () => {
    const out = html(
      '<iframe src="https://e.test"></iframe><object data="x"></object><embed src="x"><form action="/x"><input name="a"><button>b</button><select></select><textarea></textarea></form><link rel="stylesheet" href="x.css"><meta http-equiv="refresh" content="0"><base href="https://e.test/"><b>ok</b>',
    );
    expect(out).not.toMatch(/<(iframe|object|embed|form|input|button|select|textarea|link|meta|base)\b/i);
    expect(out).toContain('<b>ok</b>');
  });

  it('keeps style attributes but cleans their URLs and hooks', () => {
    const out = html('<p style="color:red;background:url(http://e.test/a.png);behavior:url(x.htc)">x</p>');
    expect(out).toContain('color:red');
    expect(out).not.toContain('http://');
    expect(out).not.toContain('behavior');
  });

  it('allows https:, data:image/, fragment and relative URLs only', () => {
    expect(isAllowedUrl('https://e.test/a.png')).toBe(true);
    expect(isAllowedUrl('data:image/png;base64,AAAA')).toBe(true);
    expect(isAllowedUrl('#top')).toBe(true);
    expect(isAllowedUrl('/api/x.png')).toBe(true);
    expect(isAllowedUrl('img/a.png')).toBe(true);
    expect(isAllowedUrl('http://e.test/a.png')).toBe(false);
    expect(isAllowedUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedUrl(' java\tscript:alert(1)')).toBe(false);
    expect(isAllowedUrl('data:text/html,<b>x</b>')).toBe(false);
    expect(isAllowedUrl('vbscript:x')).toBe(false);
    const out = html('<img src="http://e.test/a.png"><img src="https://e.test/a.png"><a href="data:text/html,x">l</a>');
    expect(out).not.toContain('http://');
    expect(out).toContain('src="https://e.test/a.png"');
    expect(out).not.toContain('data:text');
  });

  it('keeps style elements in html mode, with sanitized contents, and drops them elsewhere', () => {
    const source = '<style>@import url(https://e.test/x.css);.a{color:red}</style><p class="a">x</p>';
    const out = html(source);
    expect(out).toContain('<style>');
    expect(out).toContain('.a{color:red}');
    expect(out).not.toContain('@import');
    expect(markdown(source)).not.toContain('<style');
    expect(sanitizeHtml(source, { allowStyle: false })).not.toContain('<style');
  });
});

describe('markdown', () => {
  it('renders GFM and sanitizes embedded html', () => {
    const out = markdown(
      '# Title\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n~~gone~~ <script>alert(1)</script> [x](javascript:alert(1))',
    );
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<table>');
    expect(out).toContain('<del>gone</del>');
    expect(out).not.toMatch(/script|javascript:/i);
  });
});

describe('plain text', () => {
  it('is escaped, never markup', () => {
    expect(renderRichText({ format: 'plain', text: '<b>*x*</b>' }).html).toBe('&lt;b&gt;*x*&lt;/b&gt;');
    expect(renderRichText({ format: undefined, text: '<i>' }).html).toBe('&lt;i&gt;');
  });
});

describe('sanitizeCss', () => {
  it('strips @import, @font-face and @namespace statements and blocks', () => {
    const out = sanitizeCss(
      '@import url("https://e.test/a.css");@namespace svg url(http://www.w3.org/2000/svg);@font-face{font-family:x;src:url(https://e.test/f.woff2)}.a{color:red}',
    );
    expect(out).toBe('.a{color:red}');
  });

  it('strips expression(, behavior:, -moz-binding and </style', () => {
    const out = sanitizeCss('a{width:expression(alert(1));behavior:url(x.htc);-moz-binding:url(x.xml#y)}</style><b>');
    expect(out).not.toMatch(/expression|behavior|-moz-binding|<\/style/i);
  });

  it('sees through comments and escapes', () => {
    const out = sanitizeCss(
      '@\\69mport "x.css"; @im/**/port "y"; a{b:u\\72l(http://e.test/a.png); c:ex/**/pression(1)}',
    );
    expect(out).not.toMatch(/import|http:|expression/i);
    expect(out).toContain('url("")');
  });

  it('only keeps allowed url() targets and rebuilds them quoted', () => {
    expect(sanitizeCss('a{background:url(https://e.test/a.png)}')).toBe('a{background:url("https://e.test/a.png")}');
    expect(sanitizeCss('a{background:url( "data:image/png;base64,AAAA" )}')).toContain(
      'url("data:image/png;base64,AAAA")',
    );
    expect(sanitizeCss('a{background:url(/img/a.png)}')).toContain('url("/img/a.png")');
    expect(sanitizeCss('a{background:url(javascript:alert(1))}')).toBe('a{background:url("")}');
    expect(sanitizeCss('a{background:url(http://e.test/a.png)}')).toBe('a{background:url("")}');
    expect(sanitizeCss('a{background:image-set("http://e.test/a.png" 1x)}')).toBe('a{background:none}');
  });

  it('leaves ordinary CSS alone', () => {
    const css = '.entry{display:flex;gap:calc(var(--u) * 1);content:"a;b"}@media (min-width:10px){.x{color:#fff}}';
    expect(sanitizeCss(css)).toBe(css);
  });
});

describe('placeholder substitution', () => {
  const values = { note: `<b>"Tom" & 'Jerry'</b>`, md: '# a*b*' };
  it('escapes values per format and leaves the template alone', () => {
    expect(fillPlaceholders('<p>{note}</p> {nope}', values, 'html')).toBe(
      '<p>&lt;b&gt;&quot;Tom&quot; &amp; &#39;Jerry&#39;&lt;/b&gt;</p> {nope}',
    );
    expect(fillPlaceholders('**{md}**', values, 'markdown')).toBe('**\\# a\\*b\\***');
    expect(fillPlaceholders('{md}', values, 'plain')).toBe('# a*b*');
  });
  it('does not resolve inherited object keys', () => {
    expect(fillPlaceholders('{constructor}', {}, 'plain')).toBe('{constructor}');
  });
});
