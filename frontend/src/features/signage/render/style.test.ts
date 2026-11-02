import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerFontFaces } from './style';

class StubFace {
  static instances: StubFace[] = [];
  static failNext = 0;
  status = 'unloaded';
  constructor(
    public family: string,
    public source: string,
  ) {
    StubFace.instances.push(this);
  }
  load() {
    if (StubFace.failNext > 0) {
      StubFace.failNext -= 1;
      this.status = 'error';
      return Promise.reject(new Error('network'));
    }
    this.status = 'loaded';
    return Promise.resolve(this);
  }
}

function stubDoc() {
  const set = new Set<StubFace>();
  const doc = document.implementation.createHTMLDocument('x');
  Object.defineProperty(doc, 'fonts', {
    value: {
      add: vi.fn((f: StubFace) => set.add(f)),
      delete: vi.fn((f: StubFace) => set.delete(f)),
      has: (f: StubFace) => set.has(f),
    },
  });
  return { doc, set };
}

describe('registerFontFaces', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    StubFace.instances = [];
    StubFace.failNext = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const font = { family: 'Brand', url: '/a/brand.woff2' };

  it('adds and loads a font once for repeated calls', async () => {
    vi.stubGlobal('FontFace', StubFace);
    const { doc, set } = stubDoc();
    registerFontFaces([font], doc);
    registerFontFaces([font], doc);
    await vi.advanceTimersByTimeAsync(0);
    registerFontFaces([font], doc);
    expect(StubFace.instances).toHaveLength(1);
    expect(set.size).toBe(1);
    expect(StubFace.instances[0].source).toBe('url("/a/brand.woff2") format("woff2")');
  });

  it('retries a failed load after 5 s with a fresh face', async () => {
    vi.stubGlobal('FontFace', StubFace);
    const { doc, set } = stubDoc();
    StubFace.failNext = 1;
    registerFontFaces([font], doc);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(StubFace.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(StubFace.instances).toHaveLength(2);
    expect(set.has(StubFace.instances[0])).toBe(false);
    expect(set.has(StubFace.instances[1])).toBe(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(StubFace.instances).toHaveLength(2);
  });

  it('retries a face in error status on the next call', async () => {
    vi.stubGlobal('FontFace', StubFace);
    const { doc, set } = stubDoc();
    StubFace.failNext = 1;
    registerFontFaces([font], doc);
    await vi.advanceTimersByTimeAsync(0);
    registerFontFaces([font], doc);
    expect(StubFace.instances).toHaveLength(2);
    expect(set.has(StubFace.instances[0])).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(StubFace.instances).toHaveLength(2);
  });

  it('falls back to a style element without the Font Loading API', () => {
    const doc = document.implementation.createHTMLDocument('x');
    registerFontFaces([font], doc);
    registerFontFaces([font], doc);
    const styles = doc.head.querySelectorAll('style[data-signage-fonts]');
    expect(styles).toHaveLength(1);
    expect(styles[0].textContent).toContain('font-family: "Brand"');
  });
});
