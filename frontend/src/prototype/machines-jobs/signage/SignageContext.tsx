/* eslint-disable react-refresh/only-export-components -- provider and hook form one module, like the prototype store */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useStore } from '../store';
import { PAIRING_CODE, displaysSeed, mediaSeed, playlistsSeed, scenesSeed, servicesSeed } from './mockData';
import { displaySceneIds, displayUsesPlaylist, publishedScenesUsingMedia, uid } from './helpers';
import { emptyZones, remapZones } from './templates';
import type { Announcement, Display, LocalService, MediaItem, Orientation, Playlist, PlaylistItem, Resolution, Rule, Scene, ServiceKind, Sim } from './types';

export const DEFAULT_SIM: Sim = { h2d: 'idle', x1c: 'idle', coreReachable: true, announcement: false };

export type PairInput = { code: string; name: string; location: string; orientation: Orientation; resolution: Resolution; outside: boolean; defaultPlaylistId: string };
export type DisplaySettings = Pick<Display, 'name' | 'location' | 'orientation' | 'resolution' | 'outside'>;
export type PairResult = { ok: true; display: Display } | { ok: false; error: string };

type State = { displays: Display[]; scenes: Scene[]; playlists: Playlist[]; media: MediaItem[]; services: LocalService[]; paired: boolean };

type Api = State & {
  sim: Sim;
  setSim: (patch: Partial<Sim>) => void;
  resetSignage: () => void;
  pairDisplay: (input: PairInput) => PairResult;
  updateDisplaySettings: (id: string, settings: DisplaySettings) => void;
  setDefaultPlaylist: (id: string, playlistId: string) => void;
  addRule: (displayId: string, rule: Omit<Rule, 'id' | 'enabled'>) => void;
  updateRule: (displayId: string, ruleId: string, patch: Partial<Omit<Rule, 'id'>>) => void;
  toggleRule: (displayId: string, ruleId: string, enabled: boolean) => void;
  moveRule: (displayId: string, ruleId: string, direction: -1 | 1) => void;
  deleteRule: (displayId: string, ruleId: string) => void;
  publishDisplay: (id: string) => void;
  startAnnouncement: (id: string, announcement: Announcement) => void;
  stopAnnouncement: (id: string) => void;
  revokeDisplay: (id: string) => void;
  deleteDisplay: (id: string) => void;
  rotateCredential: (id: string) => void;
  createScene: (input: { name: string; orientation: Orientation; templateId: string }) => Scene;
  updateScene: (id: string, change: (scene: Scene) => Scene) => void;
  changeTemplate: (id: string, templateId: string) => void;
  createPlaylist: (name: string) => Playlist;
  updatePlaylist: (id: string, change: (items: PlaylistItem[]) => PlaylistItem[]) => void;
  addMedia: (item: MediaItem) => void;
  deleteMedia: (id: string) => void;
  enrollService: (kind: ServiceKind) => string;
  rotateService: (id: string) => void;
  revokeService: (id: string) => void;
};

const initial = (): State => structuredClone({ displays: displaysSeed, scenes: scenesSeed, playlists: playlistsSeed, media: mediaSeed, services: servicesSeed, paired: false });

const SignageContext = createContext<Api | null>(null);

export function useSignage(): Api {
  const value = useContext(SignageContext);
  if (!value) throw new Error('useSignage must be used inside SignageProvider');
  return value;
}

const withPending = (display: Display, label: string): Display => (display.pending.includes(label) ? display : { ...display, pending: [...display.pending, label] });

export function SignageProvider({ children }: { children: ReactNode }) {
  const store = useStore();
  const [state, setState] = useState<State>(initial);
  const [sim, setSimState] = useState<Sim>(DEFAULT_SIM);
  // The simulation follows across tabs, so a second window with the fullscreen player reacts to the controls.
  const simRef = useRef<Sim>(DEFAULT_SIM);
  const channel = useRef<BroadcastChannel | null>(null);
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return undefined;
    const bc = new BroadcastChannel('signage-sim');
    channel.current = bc;
    bc.onmessage = (event: MessageEvent<Sim>) => { simRef.current = event.data; setSimState(event.data); };
    return () => { bc.close(); channel.current = null; };
  }, []);

  const patchDisplay = useCallback((id: string, change: (display: Display) => Display) => setState((s) => ({ ...s, displays: s.displays.map((display) => display.id === id ? change(display) : display) })), []);
  const touchDisplays = (s: State, uses: (display: Display) => boolean, label: string): Display[] => s.displays.map((display) => uses(display) && !display.revoked ? withPending(display, label) : display);

  const api = useMemo<Api>(() => ({
    ...state,
    sim,
    setSim: (patch) => { const next = { ...simRef.current, ...patch }; simRef.current = next; setSimState(next); channel.current?.postMessage(next); },
    resetSignage: () => { setState(initial()); simRef.current = DEFAULT_SIM; setSimState(DEFAULT_SIM); channel.current?.postMessage(DEFAULT_SIM); },
    pairDisplay: (input) => {
      if (input.code.trim().toUpperCase() !== PAIRING_CODE) return { ok: false, error: 'No screen is waiting for this code. Codes expire after 15 minutes.' };
      const playlist = state.playlists.find((item) => item.id === input.defaultPlaylistId) ?? state.playlists[0];
      const display: Display = {
        id: uid('display'), name: input.name.trim(), location: input.location.trim(), orientation: input.orientation, resolution: input.resolution, outside: input.outside,
        status: 'online', lastSeenAt: new Date().toISOString(), syncPercent: 100, revoked: false, playerVersion: '0.9.3', cacheGb: 0, cacheLimitGb: 8, rules: [], defaultPlaylistId: playlist.id,
        pending: [], revision: 1, publishedAt: new Date().toISOString(), announcement: null, errors: [],
        published: { rules: [], defaultPlaylistId: playlist.id, scenes: structuredClone(state.scenes), playlists: structuredClone(state.playlists) },
      };
      setState((s) => ({ ...s, displays: [...s.displays, display], paired: true }));
      return { ok: true, display };
    },
    updateDisplaySettings: (id, settings) => patchDisplay(id, (display) => ({ ...display, ...settings, name: settings.name.trim(), location: settings.location.trim() })),
    setDefaultPlaylist: (id, playlistId) => patchDisplay(id, (display) => display.defaultPlaylistId === playlistId ? display : withPending({ ...display, defaultPlaylistId: playlistId }, 'Default playlist changed')),
    addRule: (displayId, rule) => patchDisplay(displayId, (display) => withPending({ ...display, rules: [...display.rules, { ...rule, id: uid('rule'), enabled: true }] }, 'Rule added')),
    updateRule: (displayId, ruleId, patch) => patchDisplay(displayId, (display) => withPending({ ...display, rules: display.rules.map((rule) => rule.id === ruleId ? { ...rule, ...patch } : rule) }, 'Rule changed')),
    toggleRule: (displayId, ruleId, enabled) => patchDisplay(displayId, (display) => withPending({ ...display, rules: display.rules.map((rule) => rule.id === ruleId ? { ...rule, enabled } : rule) }, 'Rule changed')),
    moveRule: (displayId, ruleId, direction) => patchDisplay(displayId, (display) => {
      const index = display.rules.findIndex((rule) => rule.id === ruleId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= display.rules.length) return display;
      const rules = [...display.rules];
      [rules[index], rules[target]] = [rules[target], rules[index]];
      return withPending({ ...display, rules }, 'Rules reordered');
    }),
    deleteRule: (displayId, ruleId) => patchDisplay(displayId, (display) => withPending({ ...display, rules: display.rules.filter((rule) => rule.id !== ruleId) }, 'Rule removed')),
    publishDisplay: (id) => {
      setState((s) => ({
        ...s,
        displays: s.displays.map((display) => display.id !== id ? display : {
          ...display, pending: [], revision: display.revision + 1, publishedAt: new Date().toISOString(),
          published: { rules: structuredClone(display.rules), defaultPlaylistId: display.defaultPlaylistId, scenes: structuredClone(s.scenes), playlists: structuredClone(s.playlists) },
          status: display.status === 'online' ? 'syncing' : display.status, syncPercent: 30,
        }),
      }));
      window.setTimeout(() => patchDisplay(id, (display) => display.status === 'syncing' ? { ...display, syncPercent: 75 } : display), 700);
      window.setTimeout(() => patchDisplay(id, (display) => display.status === 'syncing' ? { ...display, status: 'online', syncPercent: 100 } : display), 1500);
    },
    startAnnouncement: (id, announcement) => patchDisplay(id, (display) => ({ ...display, announcement })),
    stopAnnouncement: (id) => patchDisplay(id, (display) => ({ ...display, announcement: null })),
    revokeDisplay: (id) => patchDisplay(id, (display) => ({ ...display, revoked: true, status: 'offline', announcement: null })),
    deleteDisplay: (id) => setState((s) => ({ ...s, displays: s.displays.filter((display) => display.id !== id || !display.revoked) })),
    rotateCredential: () => store.notify({ kind: 'success', title: 'Credential rotated', subtitle: 'The player picks up its new credential on the next heartbeat.' }),
    createScene: (input) => {
      const scene: Scene = { id: uid('scene'), name: input.name.trim(), orientation: input.orientation, templateId: input.templateId, zones: emptyZones(input.templateId), background: '#161616', theme: 'dark' };
      setState((s) => ({ ...s, scenes: [...s.scenes, scene] }));
      return scene;
    },
    updateScene: (id, change) => setState((s) => ({
      ...s,
      scenes: s.scenes.map((scene) => scene.id === id ? change(scene) : scene),
      displays: touchDisplays(s, (display) => displaySceneIds(display, s.playlists).has(id), `Scene “${s.scenes.find((scene) => scene.id === id)?.name ?? ''}” edited`),
    })),
    changeTemplate: (id, templateId) => setState((s) => ({
      ...s,
      scenes: s.scenes.map((scene) => scene.id === id ? { ...scene, templateId, zones: remapZones(scene, templateId) } : scene),
      displays: touchDisplays(s, (display) => displaySceneIds(display, s.playlists).has(id), `Scene “${s.scenes.find((scene) => scene.id === id)?.name ?? ''}” edited`),
    })),
    createPlaylist: (name) => {
      const playlist: Playlist = { id: uid('pl'), name: name.trim(), items: [] };
      setState((s) => ({ ...s, playlists: [...s.playlists, playlist] }));
      return playlist;
    },
    updatePlaylist: (id, change) => setState((s) => ({
      ...s,
      playlists: s.playlists.map((playlist) => playlist.id === id ? { ...playlist, items: change(playlist.items) } : playlist),
      displays: touchDisplays(s, (display) => displayUsesPlaylist(display, id), `Playlist “${s.playlists.find((playlist) => playlist.id === id)?.name ?? ''}” edited`),
    })),
    addMedia: (item) => {
      setState((s) => ({ ...s, media: [item, ...s.media] }));
      if (item.status === 'converting') window.setTimeout(() => setState((s) => ({ ...s, media: s.media.map((entry) => entry.id === item.id ? { ...entry, status: 'ready' } : entry) })), 4000);
    },
    deleteMedia: (id) => setState((s) => publishedScenesUsingMedia(id, s.displays).length > 0 ? s : ({ ...s, media: s.media.filter((item) => item.id !== id) })),
    enrollService: (kind) => {
      const id = uid('svc');
      const service: LocalService = { id, kind, name: kind === 'printer_connector' ? 'Printer connector' : 'Streaming gateway', state: 'offline', version: '—', detail: 'Waiting for first connection', rotatesInDays: 90 };
      setState((s) => ({ ...s, services: [...s.services, service] }));
      // The new service reports in a few seconds after the compose bundle started.
      window.setTimeout(() => setState((s) => ({ ...s, services: s.services.map((entry) => entry.id === id && entry.state === 'offline' ? { ...entry, state: 'online', version: kind === 'printer_connector' ? '1.4.2' : '0.3.0', detail: kind === 'printer_connector' ? '0 printers connected' : '0 cameras' } : entry) })), 6000);
      return `enr_${Array.from({ length: 4 }, () => Math.random().toString(36).slice(2, 8)).join('')}`;
    },
    rotateService: (id) => {
      setState((s) => ({ ...s, services: s.services.map((service) => service.id === id ? { ...service, rotatesInDays: 90 } : service) }));
      store.notify({ kind: 'success', title: 'Credential rotated', subtitle: 'The service switches to the new credential automatically.' });
    },
    revokeService: (id) => setState((s) => ({ ...s, services: s.services.map((service) => service.id === id ? { ...service, state: 'revoked' } : service) })),
  }), [state, sim, patchDisplay, store]);

  return <SignageContext.Provider value={api}>{children}</SignageContext.Provider>;
}
