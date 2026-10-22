import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SignagePlayerCalendar, SignageWidget, SignageWidgetStyle } from '../../../api/generated/models';
import type { CustomLayoutShape } from '../layouts';
import { SceneRenderer } from './SceneRenderer';
import type { RenderData, RenderScene } from './types';

const NOW = Date.parse('2026-10-22T10:00:00Z'); // Thursday, week 43, Vienna time zone
const FONT = '0192f6f8-743e-7c77-a349-cd07c3e8f001';

const data = (patch: Partial<RenderData> = {}): RenderData => ({
  now: NOW,
  liveAvailable: true,
  machines: [],
  announcements: [],
  openDays: [],
  events: [],
  timeZone: 'Europe/Vienna',
  assetUrl: (id) => (id === FONT ? '/api/v1/signage/assets/font/content?v=abc' : null),
  assetName: (id) => (id === FONT ? 'Fira "Sans"' : null),
  ...patch,
});

const scene = (zones: Record<string, SignageWidget>, patch: Partial<RenderScene> = {}): RenderScene => ({
  orientation: 'landscape',
  layoutId: 'full',
  customLayoutId: null,
  backgroundColor: '#161616',
  backgroundAssetId: null,
  backgroundFit: 'cover',
  backgroundDim: 0,
  theme: 'dark',
  zones,
  ...patch,
});

const style = (patch: Partial<SignageWidgetStyle> = {}): SignageWidgetStyle => ({
  textColor: null,
  backgroundColor: null,
  borderColor: null,
  backgroundOpacity: 100,
  padding: 2,
  radius: 0,
  borderWidth: 0,
  fontScale: 100,
  fontFamily: 'inherit',
  fontAssetId: null,
  align: 'inherit',
  verticalAlign: 'inherit',
  ...patch,
});

const text = (extra: Record<string, unknown> = {}): SignageWidget =>
  ({ type: 'text', text: 'Hello', size: 'm', align: 'start', ...extra }) as SignageWidget;

const zoneEl = (container: HTMLElement, type: string) => container.querySelector<HTMLElement>(`.sg-zone--${type}`)!;
const shadowOf = (container: HTMLElement) => container.querySelector<HTMLElement>('.sg-rich')?.shadowRoot ?? null;

describe('custom layouts', () => {
  const free: CustomLayoutShape = {
    id: 'free-1',
    mode: 'free',
    columns: [1],
    rows: [1],
    zones: [
      { id: 'back', label: 'Back', grid: null, rect: { x: 0, y: 0, width: 100, height: 100 } },
      { id: 'badge', label: 'Badge', grid: null, rect: { x: 62.5, y: 5.25, width: 30, height: 12.5 } },
    ],
  };
  const grid: CustomLayoutShape = {
    id: 'grid-1',
    mode: 'grid',
    columns: [2, 1],
    rows: [1, 3],
    zones: [
      { id: 'a', label: 'A', grid: { col: 1, row: 1, colSpan: 2, rowSpan: 1 }, rect: null },
      { id: 'b', label: 'B', grid: { col: 2, row: 2, colSpan: 1, rowSpan: 1 }, rect: null },
    ],
  };

  it('places free zones absolutely in percent and stacks them in array order', () => {
    const { container } = render(
      <SceneRenderer
        scene={scene(
          { back: text({ text: 'Back' }), badge: text({ text: 'Badge' }) },
          { layoutId: 'custom', customLayoutId: 'free-1' },
        )}
        data={data({ customLayouts: [free] })}
      />,
    );
    const zones = container.querySelectorAll<HTMLElement>('.sg-zone');
    expect(container.querySelector('.sg-scene')).toHaveClass('sg-scene--free');
    expect(zones).toHaveLength(2);
    expect(zones[1].style.insetInlineStart).toBe('62.5%');
    expect(zones[1].style.insetBlockStart).toBe('5.25%');
    expect(zones[1].style.inlineSize).toBe('30%');
    expect(zones[1].style.blockSize).toBe('12.5%');
    expect(Number(zones[1].style.zIndex)).toBeGreaterThan(Number(zones[0].style.zIndex));
    expect(screen.getByText('Badge')).toBeInTheDocument();
  });

  it('lays out custom grids with fr tracks', () => {
    const { container } = render(
      <SceneRenderer
        scene={scene(
          { a: text({ text: 'A' }), b: text({ text: 'B' }) },
          { layoutId: 'custom', customLayoutId: 'grid-1' },
        )}
        data={data({ customLayouts: [grid] })}
      />,
    );
    const root = container.querySelector<HTMLElement>('.sg-scene')!;
    expect(root.style.gridTemplateColumns).toBe('2fr 1fr');
    expect(root.style.gridTemplateRows).toBe('1fr 3fr');
    expect(container.querySelectorAll<HTMLElement>('.sg-zone')[1].style.gridColumn).toBe('2 / span 1');
  });

  it('takes the layout list from the prop when given', () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({ back: text() }, { layoutId: 'custom', customLayoutId: 'free-1' })}
        data={data()}
        customLayouts={[free]}
      />,
    );
    expect(container.querySelector('.sg-scene')).toHaveClass('sg-scene--free');
  });

  it('falls back to the first built-in layout when the custom layout is missing', () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({ main: text({ text: 'Fallback' }) }, { layoutId: 'custom', customLayoutId: 'gone' })}
        data={data()}
      />,
    );
    expect(container.querySelector('.sg-scene')).not.toHaveClass('sg-scene--free');
    expect(screen.getByText('Fallback')).toBeInTheDocument();
  });
});

describe('widget style', () => {
  it('applies colours, padding, radius, border, font scale and alignment to the zone box', () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({
          main: text({
            style: style({
              textColor: '#ff0000',
              backgroundColor: '#0000ff',
              backgroundOpacity: 50,
              borderColor: '#00ff00',
              borderWidth: 5,
              padding: 3,
              radius: 1.5,
              fontScale: 150,
              fontFamily: 'serif',
              align: 'center',
              verticalAlign: 'end',
            }),
          }),
        })}
        data={data()}
      />,
    );
    const zone = zoneEl(container, 'text');
    expect(zone.style.color).toBe('rgb(255, 0, 0)');
    expect(zone.style.background).toBe('rgba(0, 0, 255, 0.5)');
    expect(zone.style.padding).toBe('calc(var(--sg-u) * 3)');
    expect(zone.style.borderRadius).toBe('calc(var(--sg-u) * 1.5)');
    expect(zone.style.border).toContain('solid');
    expect(zone.style.border).toContain('calc(var(--sg-u) * 0.5)');
    expect(zone.style.getPropertyValue('--u')).toBe('calc(var(--sg-u) * 1.5)');
    expect(zone.style.fontFamily).toContain('IBM Plex Serif');
    expect(zone.style.textAlign).toBe('center');
    expect(zone.style.alignItems).toBe('flex-end');
    expect(zone).toHaveClass('sg-zone--valign');
    // The widget's own align is overridden by the style's.
    expect(screen.getByText('Hello')).toHaveStyle({ textAlign: 'center' });
  });

  it('leaves zones without a style as before', () => {
    const { container } = render(<SceneRenderer scene={scene({ main: text() })} data={data()} />);
    const zone = zoneEl(container, 'text');
    // Only the grid placement: no colours, padding or font settings.
    expect(zone.getAttribute('style')).not.toMatch(/color|padding|font|--u/);
    expect(zone).not.toHaveClass('sg-zone--styled');
  });

  it('turns an empty widget with a style into a coloured box', () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({ main: { type: 'empty', style: style({ backgroundColor: '#112233' }) } })}
        data={data()}
      />,
    );
    expect(zoneEl(container, 'empty').style.background).toBe('rgb(17, 34, 51)');
  });

  it('uses the style of the announcement widget from boxStyle', () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({
          main: {
            type: 'announcement',
            templateIds: [],
            style: 'card',
            size: 'm',
            whenNone: 'empty',
            fallbackText: '',
            whenMany: 'stack',
            rotateSeconds: 10,
            boxStyle: style({ backgroundColor: '#112233' }),
          },
        })}
        data={data()}
      />,
    );
    expect(zoneEl(container, 'announcement').style.background).toBe('rgb(17, 34, 51)');
  });

  it('registers the scene fonts once per document, named by the asset, and uses them in the zone', () => {
    const widget = text({ style: style({ fontFamily: 'custom', fontAssetId: FONT }), fontAssetIds: [FONT] });
    const { container, rerender } = render(<SceneRenderer scene={scene({ main: widget })} data={data()} />);
    rerender(<SceneRenderer scene={scene({ main: widget })} data={data({ now: NOW + 1000 })} />);
    const rules = [...document.head.querySelectorAll('style[data-signage-fonts]')].map((item) => item.textContent);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('font-family: "Fira \\"Sans\\""');
    expect(rules[0]).toContain('url("/api/v1/signage/assets/font/content?v=abc")');
    expect(rules[0]).toContain('format("woff2")');
    expect(zoneEl(container, 'text').style.fontFamily).toContain('Fira');
  });
});

describe('rich text widget', () => {
  it('keeps plain text as text nodes', () => {
    const { container } = render(<SceneRenderer scene={scene({ main: text({ text: '<b>x</b>' }) })} data={data()} />);
    expect(screen.getByText('<b>x</b>')).toBeInTheDocument();
    expect(container.querySelector('.sg-rich')?.shadowRoot).toBeFalsy();
  });

  it('renders markdown into a shadow root with scoped CSS, loading the renderer lazily', async () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({
          main: text({
            format: 'markdown',
            text: '# Title\n\n**bold** <script>alert(1)</script>',
            css: 'h1 { color: red }',
          }),
        })}
        data={data()}
      />,
    );
    await waitFor(() => expect(shadowOf(container)?.querySelector('h1')).toBeTruthy());
    const root = shadowOf(container)!;
    expect(root.querySelector('h1')?.textContent).toBe('Title');
    expect(root.querySelector('strong')?.textContent).toBe('bold');
    expect(root.querySelector('script')).toBeNull();
    const css = [...root.querySelectorAll('style')].map((item) => item.textContent).join('\n');
    expect(css).toContain('h1 { color: red }');
    // Scoped: neither the document nor its light DOM carries the author CSS.
    expect(container.querySelector('style')).toBeNull();
    expect(document.head.textContent).not.toContain('color: red');
  });

  it('renders html with its own style element inside the shadow root only', async () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({ main: text({ format: 'html', text: '<style>p{color:blue}</style><p onclick="x()">Hi</p>' }) })}
        data={data()}
      />,
    );
    await waitFor(() => expect(shadowOf(container)?.querySelector('p')).toBeTruthy());
    const root = shadowOf(container)!;
    expect(root.querySelector('p')?.hasAttribute('onclick')).toBe(false);
    expect([...root.querySelectorAll('style')].some((item) => item.textContent?.includes('p{color:blue}'))).toBe(true);
    expect(container.querySelector('p')).toBeNull();
  });
});

describe('announcement body', () => {
  it('renders a markdown body through the rich text renderer', async () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({
          main: {
            type: 'announcement',
            templateIds: [],
            style: 'card',
            size: 'm',
            whenNone: 'empty',
            fallbackText: '',
            whenMany: 'stack',
            rotateSeconds: 10,
          },
        })}
        data={data({
          announcements: [
            {
              id: 'a',
              templateId: 't',
              tone: 'info',
              title: 'Closed',
              body: 'Back **tomorrow**',
              bodyFormat: 'markdown',
              bodyCss: 'strong { color: red }',
              startsAt: NOW,
            },
          ],
        })}
      />,
    );
    expect(screen.getByText('Closed')).toBeInTheDocument();
    await waitFor(() => expect(shadowOf(container)?.querySelector('strong')).toBeTruthy());
    expect(shadowOf(container)!.querySelector('strong')?.textContent).toBe('tomorrow');
  });

  it('keeps plain bodies as text', () => {
    render(
      <SceneRenderer
        scene={scene({
          main: {
            type: 'announcement',
            templateIds: [],
            style: 'card',
            size: 'm',
            whenNone: 'empty',
            fallbackText: '',
            whenMany: 'stack',
            rotateSeconds: 10,
          },
        })}
        data={data({
          announcements: [{ id: 'a', templateId: 't', tone: 'info', title: 'T', body: '<b>raw</b>', startsAt: NOW }],
        })}
      />,
    );
    expect(screen.getByText('<b>raw</b>')).toBeInTheDocument();
  });
});

describe('open day, event and agenda lists', () => {
  // Vienna is on summer time (UTC+2) until Sunday 25 October.
  const openDays = [{ startsAt: '2026-10-23T14:00:00Z', endsAt: '2026-10-23T18:00:00Z', status: 'scheduled' }];
  const events = [
    { title: 'Soldering workshop', startsAt: '2026-10-22T18:00:00Z', endsAt: null, location: 'Room 2' },
    { title: 'Laser night', startsAt: '2026-10-24T15:30:00Z', endsAt: '2026-10-24T17:00:00Z', location: null },
  ];

  it('keeps the previous row layout without a template and the default heading', () => {
    render(<SceneRenderer scene={scene({ main: { type: 'open_days', count: 5 } })} data={data({ openDays })} />);
    expect(screen.getByText('Next open days')).toBeInTheDocument();
    expect(screen.getByText('Fri 23 Oct')).toBeInTheDocument();
    expect(screen.getByText('16:00–20:00')).toBeInTheDocument();
  });

  it('honours title, empty title and empty text', () => {
    const { rerender } = render(
      <SceneRenderer
        scene={scene({ main: { type: 'events', count: 5, title: 'Soon', emptyText: 'Nothing here' } })}
        data={data()}
      />,
    );
    expect(screen.getByText('Soon')).toBeInTheDocument();
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    rerender(<SceneRenderer scene={scene({ main: { type: 'events', count: 5, title: '' } })} data={data()} />);
    expect(screen.queryByText('Upcoming events')).not.toBeInTheDocument();
    expect(screen.getByText('No events planned')).toBeInTheDocument();
  });

  it('renders one rich document with a wrapped entry per item and escaped placeholder values', async () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({
          main: {
            type: 'events',
            count: 5,
            format: 'html',
            entryTemplate:
              '<b>{title}</b> {weekday_short} {day} {month_short} {year} {start}-{end} @ {location} {kind}',
            css: '.entry { color: red }',
          },
        })}
        data={data({ events: [{ ...events[0], title: '<i>Solder</i> & co' }, events[1]] })}
      />,
    );
    await waitFor(() => expect(shadowOf(container)?.querySelectorAll('.entry')).toHaveLength(2));
    const entries = shadowOf(container)!.querySelectorAll('.entry.entry--event');
    expect(entries).toHaveLength(2);
    expect(entries[0].textContent).toBe('<i>Solder</i> & co Thu 22 Oct 2026 20:00- @ Room 2 Event');
    expect(entries[0].querySelector('i')).toBeNull();
    expect(entries[1].textContent).toContain('17:30-19:00');
    expect(
      [...shadowOf(container)!.querySelectorAll('style')].some((item) => item.textContent?.includes('.entry')),
    ).toBe(true);
  });

  it('wraps markdown entries too', async () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({
          main: { type: 'open_days', count: 5, format: 'markdown', entryTemplate: '**{date}** {status} {start}' },
        })}
        data={data({ openDays })}
      />,
    );
    await waitFor(() => expect(shadowOf(container)?.querySelector('.entry--open_day strong')).toBeTruthy());
    expect(shadowOf(container)!.querySelector('.entry--open_day')?.textContent).toContain('Scheduled 16:00');
  });

  it('merges open days and events by start time and honours the include switches', () => {
    const { container, rerender } = render(
      <SceneRenderer
        scene={scene({ main: { type: 'agenda', count: 10, includeOpenDays: true, includeEvents: true } })}
        data={data({ openDays, events })}
      />,
    );
    const rows = () =>
      [...container.querySelectorAll('.sg-list__row')].map((row) => row.firstElementChild?.textContent);
    expect(screen.getByText('Agenda')).toBeInTheDocument();
    expect(rows()).toEqual(['Soldering workshop', 'Fri 23 Oct', 'Laser night']);
    rerender(
      <SceneRenderer
        scene={scene({ main: { type: 'agenda', count: 2, includeOpenDays: false, includeEvents: true } })}
        data={data({ openDays, events })}
      />,
    );
    expect(rows()).toEqual(['Soldering workshop', 'Laser night']);
    rerender(
      <SceneRenderer
        scene={scene({ main: { type: 'agenda', count: 10, includeOpenDays: false, includeEvents: false } })}
        data={data({ openDays, events })}
      />,
    );
    expect(screen.getByText('Nothing planned')).toBeInTheDocument();
  });

  it('uses the template of each kind in an agenda document', async () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({
          main: {
            type: 'agenda',
            count: 10,
            includeOpenDays: true,
            includeEvents: true,
            format: 'html',
            openDayTemplate: 'OPEN {date}',
            eventTemplate: 'EVENT {title}',
          },
        })}
        data={data({ openDays, events })}
      />,
    );
    await waitFor(() => expect(shadowOf(container)?.querySelectorAll('.entry')).toHaveLength(3));
    expect([...shadowOf(container)!.querySelectorAll('.entry')].map((item) => item.textContent)).toEqual([
      'EVENT Soldering workshop',
      'OPEN Fri 23 Oct',
      'EVENT Laser night',
    ]);
  });
});

describe('calendar widget', () => {
  const calendar: SignagePlayerCalendar = {
    from: '2026-09-24',
    to: '2026-12-10',
    holidays: [{ date: '2026-10-26', name: 'National Day' }],
    breaks: [{ name: 'Autumn break', startsOn: '2026-10-27', endsOn: '2026-10-30' }],
    openDays: [{ startsAt: '2026-10-23T14:00:00Z', endsAt: '2026-10-23T18:00:00Z', status: 'scheduled' }],
    events: [
      { title: 'Soldering workshop', startsAt: '2026-10-22T18:00:00Z', endsAt: null, location: null },
      // Spans Nov 1 to Nov 3 (ends at midnight of the 4th).
      { title: 'Hackathon', startsAt: '2026-10-31T23:30:00Z', endsAt: '2026-11-03T23:00:00Z', location: null },
    ],
  };
  const widget = (patch: Record<string, unknown> = {}): SignageWidget =>
    ({
      type: 'calendar',
      view: 'month',
      weeks: 3,
      showHolidays: true,
      showBreaks: true,
      showOpenDays: true,
      showEvents: true,
      colors: { holiday: '#da1e28', break: '#8a3ffc', openDay: '#198038', event: '#0f62fe' },
      showWeekNumbers: false,
      title: 'Calendar',
      ...patch,
    }) as SignageWidget;
  const day = (container: HTMLElement, key: string) => container.querySelector<HTMLElement>(`[data-date="${key}"]`)!;

  // The widget is a lazy chunk: wait for it to render.
  const ready = () => screen.findByRole('group');

  it('shows the month Monday-first with the current month, today and entries', async () => {
    const { container } = render(<SceneRenderer scene={scene({ main: widget() })} data={data({ calendar })} />);
    await ready();
    expect(screen.getByText('October 2026')).toBeInTheDocument();
    expect(screen.getByText('Calendar')).toBeInTheDocument();
    const heads = [...container.querySelectorAll('.sg-cal__weekday')].map((item) => item.textContent);
    expect(heads).toEqual(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
    // October 2026 starts on a Thursday: five weeks, from Mon 28 Sep to Sun 1 Nov.
    expect(container.querySelectorAll('.sg-cal__day')).toHaveLength(35);
    expect(container.querySelector('[data-date]')?.getAttribute('data-date')).toBe('2026-09-28');
    expect(day(container, '2026-09-28')).toHaveClass('sg-cal__day--outside');
    expect(day(container, '2026-10-22')).toHaveClass('sg-cal__day--today');
    expect(within(day(container, '2026-10-22')).getByText(/Soldering workshop/)).toBeInTheDocument();
    expect(within(day(container, '2026-10-22')).getByText('20:00')).toBeInTheDocument();
    expect(within(day(container, '2026-10-23')).getByText(/Open day/)).toBeInTheDocument();
    expect(within(day(container, '2026-10-23')).getByText('16:00–20:00')).toBeInTheDocument();
    expect(within(day(container, '2026-10-26')).getByText('National Day')).toBeInTheDocument();
  });

  it('marks every day of a multi-day break and entry', async () => {
    const { container } = render(<SceneRenderer scene={scene({ main: widget() })} data={data({ calendar })} />);
    await ready();
    for (const key of ['2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']) {
      expect(day(container, key).style.background).not.toBe('');
      expect(within(day(container, key)).getByText('Autumn break')).toBeInTheDocument();
    }
    expect(day(container, '2026-10-31').style.background).toBe('');
    expect(day(container, '2026-10-26').style.background).toBe('');
  });

  it('shows an entry on each day it covers, with the time on the first day only', async () => {
    const { container } = render(
      <SceneRenderer scene={scene({ main: widget({ view: 'weeks', weeks: 3 }) })} data={data({ calendar })} />,
    );
    await ready();
    // Starts Sunday 1 Nov 00:30 (Vienna) and ends at midnight of Wednesday 4 Nov.
    expect(day(container, '2026-10-31').textContent).not.toContain('Hackathon');
    expect(within(day(container, '2026-11-01')).getByText('00:30')).toBeInTheDocument();
    for (const key of ['2026-11-01', '2026-11-02', '2026-11-03'])
      expect(within(day(container, key)).getByText(/Hackathon/)).toBeInTheDocument();
    expect(day(container, '2026-11-02').querySelector('.sg-cal__time')).toBeNull();
    expect(day(container, '2026-11-04').textContent).not.toContain('Hackathon');
  });

  it('toggles categories and colours the legend', async () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({ main: widget({ showHolidays: false, showBreaks: false, showEvents: false }) })}
        data={data({ calendar })}
      />,
    );
    await ready();
    expect(screen.queryByText('National Day')).not.toBeInTheDocument();
    expect(screen.queryByText('Autumn break')).not.toBeInTheDocument();
    expect(screen.queryByText(/Soldering/)).not.toBeInTheDocument();
    expect(within(day(container, '2026-10-23')).getByText(/Open day/)).toBeInTheDocument();
    const legend = within(container.querySelector<HTMLElement>('.sg-cal__legend')!);
    expect(legend.getByText('Open day')).toBeInTheDocument();
    expect(legend.queryByText('Holiday')).not.toBeInTheDocument();
    expect(container.querySelector<HTMLElement>('.sg-cal__swatch')?.style.background).toBe('rgb(25, 128, 56)');
  });

  it('shows the colours of the widget on its entries', async () => {
    const { container } = render(<SceneRenderer scene={scene({ main: widget() })} data={data({ calendar })} />);
    await ready();
    const entry = container.querySelector<HTMLElement>('.sg-cal__entry--holiday')!;
    expect(entry.style.borderInlineStartColor).toBe('rgb(218, 30, 40)');
  });

  it('shows weeks from the current ISO week with week numbers', async () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({ main: widget({ view: 'weeks', weeks: 2, showWeekNumbers: true }) })}
        data={data({ calendar })}
      />,
    );
    await ready();
    expect(container.querySelectorAll('.sg-cal__day')).toHaveLength(14);
    expect(container.querySelector('[data-date]')?.getAttribute('data-date')).toBe('2026-10-19');
    expect([...container.querySelectorAll('.sg-cal__wk[aria-label]')].map((item) => item.textContent)).toEqual([
      '43',
      '44',
    ]);
    expect(screen.queryByText('October 2026')).not.toBeInTheDocument();
  });

  it('hides the heading when the title is empty and renders without calendar data', async () => {
    const { container } = render(<SceneRenderer scene={scene({ main: widget({ title: '' }) })} data={data()} />);
    await ready();
    expect(screen.queryByText('Calendar')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.sg-cal__day')).toHaveLength(35);
    expect(container.querySelector('.sg-cal__entry')).toBeNull();
  });

  it('renders in still previews', async () => {
    const { container } = render(
      <SceneRenderer scene={scene({ main: widget() })} data={data({ calendar, still: true })} />,
    );
    await ready();
    expect(container.querySelectorAll('.sg-cal__day')).toHaveLength(35);
  });
});
