import { describe, expect, it } from 'vitest';
import { canRemoveOrigin, embedSnippet, normalizeOrigin, originProblem } from './webEmbeds';

describe('normalizeOrigin', () => {
  it('accepts https origins and lower-cases them', () => {
    expect(normalizeOrigin('https://Fachschaft-Muster.example')).toBe('https://fachschaft-muster.example');
    expect(normalizeOrigin(' https://blog.example:8443/ ')).toBe('https://blog.example:8443');
  });

  it.each([
    '',
    'example.org',
    'http://example.org',
    'https://example.org/news',
    'https://example.org?a=1',
    'https://example.org#top',
    'https://user@example.org',
    'https://*.example.org',
    'ftp://example.org',
  ])('refuses %j', (text) => {
    expect(normalizeOrigin(text)).toBeNull();
  });
});

describe('originProblem', () => {
  it('names the problem of an invalid, duplicate or surplus website', () => {
    expect(originProblem('http://a.example', [])).toMatch(/https address without a path/);
    expect(originProblem('https://A.example', ['https://a.example'])).toBe('This website is already in the list.');
    const full = Array.from({ length: 20 }, (_, index) => `https://site${index}.example`);
    expect(originProblem('https://another.example', full)).toMatch(/at most 20/);
    expect(originProblem('https://new.example', ['https://a.example'])).toBeNull();
  });
});

describe('canRemoveOrigin', () => {
  it('keeps the last website', () => {
    expect(canRemoveOrigin(['https://a.example'])).toBe(false);
    expect(canRemoveOrigin(['https://a.example', 'https://b.example'])).toBe(true);
  });
});

describe('embedSnippet', () => {
  it('builds the iframe with the embed link and the aspect ratio', () => {
    const code = embedSnippet({ embedUrl: 'https://core.example/embed/key123', aspectRatio: { width: 7, height: 3 } });
    expect(code).toContain('src="https://core.example/embed/key123"');
    expect(code).toContain('style="width:100%;aspect-ratio:7/3;border:0"');
    expect(code).toContain('loading="lazy"');
    expect(code).toContain('referrerpolicy="strict-origin"');
  });
});
