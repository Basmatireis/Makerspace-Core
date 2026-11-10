import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SignageTimelapseWidget } from '../../../api/generated/models';
import { defaultWidget } from '../widgets';
import { SceneRenderer } from './SceneRenderer';
import { sceneWith } from './testScenes';
import { timelapseCaption, timelapseClips } from './timelapseModel';
import { TimelapseWidget } from './TimelapseWidget';
import type { RenderData, RenderScene, RenderTimelapse } from './types';

const NOW = Date.parse('2026-10-22T10:00:00Z');
const DAY = 86_400_000;
const MK4 = '0192f6f8-743e-7c77-a349-cd07c3e8a001';
const X1 = '0192f6f8-743e-7c77-a349-cd07c3e8a002';

const clip = (run: string, machineId: string, endedAt: number, machineName = 'Prusa MK4'): RenderTimelapse => ({
  runId: run,
  machineId,
  machineName,
  endedAt: new Date(endedAt).toISOString(),
  sha256: run.padEnd(64, '0'),
  url: `/api/v1/signage/player/timelapses/${run}/${run.padEnd(64, '0')}`,
});

// Listed out of order on purpose: the widget sorts newest first.
const CLIPS = [clip('b', X1, NOW - 2 * DAY, 'Bambu X1'), clip('a', MK4, NOW - DAY), clip('c', MK4, NOW - 40 * DAY)];

const widget = (patch: Partial<SignageTimelapseWidget> = {}): SignageTimelapseWidget => ({
  ...(defaultWidget('timelapse') as SignageTimelapseWidget),
  ...patch,
});

const data = (patch: Partial<RenderData> = {}): RenderData => ({
  now: NOW,
  liveAvailable: true,
  machines: [],
  announcements: [],
  openDays: [],
  events: [],
  timeZone: 'Europe/Vienna',
  assetUrl: () => null,
  timelapses: CLIPS,
  timelapseUrl: (item) => item.url,
  ...patch,
});

const videoSrc = (container: HTMLElement) => container.querySelector('video')?.getAttribute('src') ?? null;

afterEach(() => {
  vi.useRealTimers();
});

describe('timelapse clips', () => {
  it('picks the newest clips of the chosen machines within the age limit', () => {
    expect(timelapseClips(widget(), data()).map((item) => item.runId)).toEqual(['a', 'b']);
    expect(timelapseClips(widget({ maxAgeDays: 0 }), data()).map((item) => item.runId)).toEqual(['a', 'b', 'c']);
    expect(timelapseClips(widget({ maxAgeDays: 0, count: 2 }), data()).map((item) => item.runId)).toEqual(['a', 'b']);
    expect(
      timelapseClips(widget({ source: 'machines', machineIds: [MK4], maxAgeDays: 0 }), data()).map(
        (item) => item.runId,
      ),
    ).toEqual(['a', 'c']);
  });

  it('skips clips without a URL and plays nothing without a URL source', () => {
    const cachedOnly = data({ timelapseUrl: (item) => (item.runId === 'b' ? item.url : null) });
    expect(timelapseClips(widget(), cachedOnly).map((item) => item.runId)).toEqual(['b']);
    expect(timelapseClips(widget(), data({ timelapseUrl: undefined }))).toEqual([]);
  });

  it('captions the machine and the day the print ended in the makerspace time zone', () => {
    expect(timelapseCaption(clip('a', MK4, Date.parse('2026-10-21T22:30:00Z')), 'Europe/Vienna')).toBe(
      'Prusa MK4 · 22 Oct',
    );
  });
});

describe('timelapse widget', () => {
  it('plays the clips newest first and moves on when a clip ends', () => {
    const { container } = render(<TimelapseWidget widget={widget()} data={data()} />);
    expect(videoSrc(container)).toBe(CLIPS[1].url);
    const video = container.querySelector('video')!;
    expect(video.autoplay).toBe(true);
    expect(video.loop).toBe(false);
    expect(video.style.objectFit).toBe('cover');
    fireEvent.ended(video);
    expect(videoSrc(container)).toBe(CLIPS[0].url);
    fireEvent.ended(container.querySelector('video')!);
    expect(videoSrc(container)).toBe(CLIPS[1].url);
  });

  it('cuts a clip off after the maximum seconds', () => {
    vi.useFakeTimers();
    const { container } = render(<TimelapseWidget widget={widget({ maxSeconds: 5 })} data={data()} />);
    act(() => {
      vi.advanceTimersByTime(4_900);
    });
    expect(videoSrc(container)).toBe(CLIPS[1].url);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(videoSrc(container)).toBe(CLIPS[0].url);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(videoSrc(container)).toBe(CLIPS[1].url);
  });

  it('restarts a single clip and keeps the timer per clip', () => {
    vi.useFakeTimers();
    const { container } = render(<TimelapseWidget widget={widget({ maxSeconds: 5, count: 1 })} data={data()} />);
    const first = container.querySelector('video');
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(container.querySelector('video')).not.toBe(first);
    expect(videoSrc(container)).toBe(CLIPS[1].url);
  });

  it('shows the caption only when switched on, and fades only with the fade transition', () => {
    const { container, rerender } = render(<TimelapseWidget widget={widget()} data={data()} />);
    expect(screen.getByText('Prusa MK4 · 21 Oct')).toBeInTheDocument();
    expect(container.querySelector('.sg-fade')).not.toBeNull();
    rerender(<TimelapseWidget widget={widget({ showCaption: false, transition: 'cut' })} data={data()} />);
    expect(screen.queryByText(/Prusa MK4 ·/)).toBeNull();
    expect(container.querySelector('.sg-fade')).toBeNull();
  });

  it('keeps thumbnails still on the first clip', () => {
    const { container } = render(<TimelapseWidget widget={widget({ fit: 'contain' })} data={data({ still: true })} />);
    const video = container.querySelector('video')!;
    expect(video.getAttribute('src')).toBe(CLIPS[1].url);
    expect(video.autoplay).toBe(false);
    expect(video.getAttribute('preload')).toBe('metadata');
    expect(video.style.objectFit).toBe('contain');
  });

  it('renders only the style box without clips', async () => {
    const scene: RenderScene = sceneWith(widget());
    const empty = render(<SceneRenderer scene={scene} data={data({ timelapses: null })} />);
    expect(empty.container.querySelector('.sg-block--timelapse')).not.toBeNull();
    expect(empty.container.querySelector('video')).toBeNull();
    empty.unmount();
    const { container } = render(<SceneRenderer scene={scene} data={data()} />);
    expect(await screen.findByText('Prusa MK4 · 21 Oct')).toBeInTheDocument();
    expect(videoSrc(container)).toBe(CLIPS[1].url);
  });
});
