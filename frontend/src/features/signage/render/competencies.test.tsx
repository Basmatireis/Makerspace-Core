import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SignagePlayerCalendar, SignageWidget } from '../../../api/generated/models';
import { entryValues, openDayEntry } from './entries';
import { SceneRenderer } from './SceneRenderer';
import type { RenderData, RenderOpenDay, RenderScene } from './types';

const NOW = Date.parse('2026-10-22T10:00:00Z');
const LONG = 'Electronics, soldering and microcontroller programming for beginners';

const day = (startsAt: string, competencies?: readonly string[], status = 'scheduled'): RenderOpenDay => ({
  startsAt,
  endsAt: new Date(Date.parse(startsAt) + 4 * 3_600_000).toISOString(),
  status,
  ...(competencies ? { competencies } : {}),
});

const openDays: RenderOpenDay[] = [
  day('2026-10-23T14:00:00Z', ['3D printing', 'Laser cutting', 'Embroidery', 'Vinyl cutting', LONG]),
  day('2026-10-30T14:00:00Z', []),
  // Cached by an older player before competencies existed.
  day('2026-11-06T14:00:00Z'),
];

const data = (patch: Partial<RenderData> = {}): RenderData => ({
  now: NOW,
  liveAvailable: true,
  machines: [],
  announcements: [],
  openDays,
  events: [{ title: 'Soldering workshop', startsAt: '2026-10-24T18:00:00Z', endsAt: null, location: null }],
  timeZone: 'Europe/Vienna',
  assetUrl: () => null,
  ...patch,
});

const scene = (widget: SignageWidget): RenderScene => ({
  orientation: 'landscape',
  layoutId: 'full',
  customLayoutId: null,
  backgroundColor: '#161616',
  backgroundAssetId: null,
  backgroundFit: 'cover',
  backgroundDim: 0,
  theme: 'dark',
  zones: { main: widget },
});

describe('planned competencies on signage', () => {
  it('fills the {competencies} placeholder and tolerates old cached data', () => {
    expect(entryValues(openDayEntry(openDays[0]), 'Europe/Vienna').competencies).toBe(
      `3D printing, Laser cutting, Embroidery, Vinyl cutting, ${LONG}`,
    );
    expect(entryValues(openDayEntry(openDays[2]), 'Europe/Vienna').competencies).toBe('');
  });

  it('leaves the open day list as it was without the option', () => {
    const { container } = render(<SceneRenderer scene={scene({ type: 'open_days', count: 3 })} data={data()} />);
    expect(container.querySelectorAll('.sg-list__row')).toHaveLength(3);
    expect(container.querySelector('.sg-chips')).toBeNull();
    expect(container.querySelector('.sg-list__item')).toBeNull();
  });

  it('adds the first four as chips and the rest as +n', () => {
    const { container } = render(
      <SceneRenderer scene={scene({ type: 'open_days', count: 3, showCompetencies: true })} data={data()} />,
    );
    const chips = container.querySelectorAll('.sg-chips');
    // Only the first day has competencies; empty and missing lists render no chips.
    expect(chips).toHaveLength(1);
    expect([...chips[0].querySelectorAll('.sg-chip')].map((chip) => chip.textContent)).toEqual([
      '3D printing',
      'Laser cutting',
      'Embroidery',
      'Vinyl cutting',
      '+1',
    ]);
    expect(container.querySelectorAll('.sg-list__row')).toHaveLength(3);
  });

  it('shows them on open-day entries of the agenda only', () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({ type: 'agenda', count: 4, includeOpenDays: true, includeEvents: true, showCompetencies: true })}
        data={data()}
      />,
    );
    expect(screen.getByText('Soldering workshop')).toBeInTheDocument();
    expect(container.querySelectorAll('.sg-chips')).toHaveLength(1);
  });

  describe('calendar', () => {
    const calendar: SignagePlayerCalendar = {
      from: '2026-09-24',
      to: '2026-12-10',
      holidays: [],
      breaks: [],
      openDays: [
        { ...day('2026-10-23T14:00:00Z'), competencies: ['3D printing', 'Laser cutting', 'Electronics'] },
        { ...day('2026-10-30T14:00:00Z'), status: 'cancelled', competencies: ['3D printing'] },
      ],
      events: [],
    };
    const widget = (patch: Record<string, unknown>): SignageWidget =>
      ({
        type: 'calendar',
        view: 'weeks',
        weeks: 3,
        showHolidays: false,
        showBreaks: false,
        showOpenDays: true,
        showEvents: false,
        colors: { holiday: '#da1e28', break: '#8a3ffc', openDay: '#198038', event: '#0f62fe' },
        showWeekNumbers: false,
        ...patch,
      }) as SignageWidget;
    const cell = (container: HTMLElement, key: string) => container.querySelector<HTMLElement>(`[data-date="${key}"]`)!;

    it('shows the first two in the weeks view, never on cancelled days', async () => {
      const { container } = render(
        <SceneRenderer scene={scene(widget({ showCompetencies: true }))} data={data({ calendar })} />,
      );
      await screen.findByRole('group');
      const chips = within(cell(container, '2026-10-23')).getAllByText(/3D printing|Laser cutting|\+1/);
      expect(chips.map((chip) => chip.textContent)).toEqual(['3D printing', 'Laser cutting', '+1']);
      expect(cell(container, '2026-10-30').querySelector('.sg-chips')).toBeNull();
    });

    it('shows none without the option or in the month view', async () => {
      for (const patch of [{}, { showCompetencies: true, view: 'month' }]) {
        const { container, unmount } = render(<SceneRenderer scene={scene(widget(patch))} data={data({ calendar })} />);
        await screen.findByRole('group');
        expect(container.querySelector('.sg-chips')).toBeNull();
        unmount();
      }
    });
  });
});
