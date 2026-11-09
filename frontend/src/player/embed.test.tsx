import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SignageEmbedSettings } from '../api/generated/models';
import { createEmbedApi, PlayerApiError } from './api';
import { embedKeyFromPath, isTopLevel } from './embed';
import { EmbedApp } from './PlayerApp';
import { EMBED_LIVE_INTERVAL_MS, EMBED_UNAVAILABLE_RECHECK_MS, MANIFEST_INTERVAL_MS, PlayerRuntime } from './runtime';
import { live, manifest } from './testFixtures';

const KEY = 'AbCdEfGhIjKlMnOpQrStUvWx';
const settings = (patch: Partial<SignageEmbedSettings> = {}): SignageEmbedSettings => ({
  enabled: true,
  openDirectly: true,
  aspectRatio: { width: 16, height: 9 },
  ...patch,
});

function embedApi(embed: SignageEmbedSettings = settings(), patch = {}) {
  return {
    manifest: vi.fn(async () => ({ embed, unchanged: false, manifest: manifest(1) })),
    live: vi.fn(async () => live()),
    ...patch,
  };
}

describe('embed mode detection', () => {
  it('recognises /embed/{key} only', () => {
    expect(embedKeyFromPath(`/embed/${KEY}`)).toBe(KEY);
    expect(embedKeyFromPath(`/embed/${KEY}/`)).toBe(KEY);
    expect(embedKeyFromPath('/embed/short')).toBeNull();
    expect(embedKeyFromPath(`/embed/${KEY}/x`)).toBeNull();
    expect(embedKeyFromPath('/player/')).toBeNull();
    expect(embedKeyFromPath('/')).toBeNull();
  });

  it('treats an unreadable top window as framed', () => {
    const win = {
      self: {},
      get top(): Window {
        throw new Error('cross-origin');
      },
    } as unknown as Window;
    expect(isTopLevel(win)).toBe(false);
    const self = {};
    expect(isTopLevel({ self, top: self } as unknown as Window)).toBe(true);
  });
});

describe('embed api', () => {
  it('calls the public embed prefix without credentials', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const api = createEmbedApi(KEY, fetchImpl as unknown as typeof fetch);
    await api.manifest(3);
    await api.live();
    const calls = fetchImpl.mock.calls as unknown as [string, RequestInit][];
    expect(calls[0][0]).toBe(`/api/v1/public/signage/embeds/${KEY}/manifest?known=3`);
    expect(calls[1][0]).toBe(`/api/v1/public/signage/embeds/${KEY}/live`);
    for (const [, init] of calls) expect(init.credentials).toBe('omit');
  });
});

describe('embed runtime', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('polls live every 30 s and the manifest every 60 s, with no heartbeat or Cache Storage', async () => {
    const api = embedApi();
    const heartbeat = vi.fn();
    const cachesOpen = vi.fn();
    vi.stubGlobal('caches', { open: cachesOpen });
    const runtime = new PlayerRuntime({
      api: { ...api, heartbeat } as never,
      embed: { isTopLevel: () => false },
      loadAsset: async () => 'ready',
    });
    runtime.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.getSnapshot()).toMatchObject({ status: 'playing', revision: 1 });
    expect(api.live).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(EMBED_LIVE_INTERVAL_MS * 2);
    expect(api.live).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(MANIFEST_INTERVAL_MS);
    expect(api.manifest.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(heartbeat).not.toHaveBeenCalled();
    expect(cachesOpen).not.toHaveBeenCalled();
    runtime.stop();
    vi.unstubAllGlobals();
  });

  it('is unavailable when switched off, re-checks every 5 minutes without live polling and recovers', async () => {
    let enabled = false;
    const api = embedApi(settings(), {
      manifest: vi.fn(async () => ({ embed: settings({ enabled }), unchanged: false, manifest: manifest(1) })),
    });
    const runtime = new PlayerRuntime({
      api,
      embed: { isTopLevel: () => false },
      loadAsset: async () => 'ready',
    });
    runtime.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.getSnapshot().status).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(MANIFEST_INTERVAL_MS * 2);
    expect(api.live).not.toHaveBeenCalled();
    expect(api.manifest).toHaveBeenCalledTimes(1);
    enabled = true;
    await vi.advanceTimersByTimeAsync(EMBED_UNAVAILABLE_RECHECK_MS);
    expect(api.manifest.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(runtime.getSnapshot()).toMatchObject({ status: 'playing', revision: 1 });
    await vi.advanceTimersByTimeAsync(EMBED_LIVE_INTERVAL_MS);
    expect(api.live).toHaveBeenCalled();
    runtime.stop();
  });

  it('is unavailable for an unknown key (404)', async () => {
    const api = embedApi(settings(), {
      manifest: vi.fn(async () => {
        throw new PlayerApiError(404, 'not_found', 'x');
      }),
    });
    const runtime = new PlayerRuntime({ api, embed: { isTopLevel: () => false } });
    runtime.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.getSnapshot().status).toBe('unavailable');
    expect(api.live).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(EMBED_UNAVAILABLE_RECHECK_MS);
    expect(api.manifest).toHaveBeenCalledTimes(2);
    runtime.stop();
  });

  it('is unavailable when opened directly although openDirectly is false', async () => {
    const api = embedApi(settings({ openDirectly: false }));
    const runtime = new PlayerRuntime({ api, embed: { isTopLevel: () => true } });
    runtime.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.getSnapshot().status).toBe('unavailable');
    await vi.advanceTimersByTimeAsync(MANIFEST_INTERVAL_MS * 2);
    expect(api.live).not.toHaveBeenCalled();
    expect(api.manifest).toHaveBeenCalledTimes(1);
  });

  it('plays when opened directly and openDirectly is true', async () => {
    const runtime = new PlayerRuntime({
      api: embedApi(),
      embed: { isTopLevel: () => true },
      loadAsset: async () => 'ready',
    });
    runtime.start();
    await vi.advanceTimersByTimeAsync(100);
    expect(runtime.getSnapshot().status).toBe('playing');
    runtime.stop();
  });
});

describe('EmbedApp', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the scene inside a frame', async () => {
    render(<EmbedApp api={embedApi()} isTop={() => false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText('scene-a')).toBeInTheDocument();
  });

  it('shows the neutral screen when the embed is switched off', async () => {
    const api = embedApi(settings({ enabled: false }), {
      manifest: vi.fn(async () => ({ embed: settings({ enabled: false }), unchanged: false })),
    });
    render(<EmbedApp api={api} isTop={() => false} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText("This screen isn't available")).toBeInTheDocument();
  });

  it('shows the neutral screen when not framed and openDirectly is false', async () => {
    render(<EmbedApp api={embedApi(settings({ openDirectly: false }))} isTop={() => true} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    expect(screen.getByText("This screen isn't available")).toBeInTheDocument();
  });
});
