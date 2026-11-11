import { render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { SignageBlockStyle, SignagePlayerCalendar, SignageWidget } from '../../../api/generated/models';
import { buildPreviewData } from '../preview';
import { SceneRenderer } from './SceneRenderer';
import { blockOf, sceneOf } from './testScenes';
import type { RenderData, RenderScene } from './types';

const NOW = Date.parse('2026-10-22T10:00:00Z'); // Thursday, week 43, Vienna time zone
const FONT = '0192f6f8-743e-7c77-a349-cd07c3e8f001';
const IMAGE = '0192f6f8-743e-7c77-a349-cd07c3e8f0b1';

const data = (patch: Partial<RenderData> = {}): RenderData => ({
  now: NOW,
  liveAvailable: true,
  machines: [],
  announcements: [],
  openDays: [],
  events: [],
  timeZone: 'Europe/Vienna',
  assetUrl: (id) =>
    id === FONT ? '/api/v1/signage/assets/font/content?v=abc' : id === IMAGE ? '/media/photo.png' : null,
  assetName: (id) => (id === FONT ? 'Fira "Sans"' : null),
  ...patch,
});

/** One full-screen block per entry (in order); `styles` patches a block's style. */
const scene = (
  widgets: Record<string, SignageWidget>,
  patch: Partial<RenderScene> = {},
  styles: Record<string, Partial<SignageBlockStyle>> = {},
): RenderScene =>
  sceneOf(
    Object.entries(widgets).map(([id, widget]) => blockOf(widget, { id, name: id, style: styles[id] })),
    patch,
  );

const text = (extra: Record<string, unknown> = {}): SignageWidget =>
  ({ type: 'text', text: 'Hello', fit: false, ...extra }) as SignageWidget;

const blockEl = (container: HTMLElement, id = 'main') =>
  container.querySelector<HTMLElement>(`[data-block-id="${id}"]`)!;
const shadowOf = (container: HTMLElement) => container.querySelector<HTMLElement>('.sg-rich')?.shadowRoot ?? null;

describe('block geometry and stacking', () => {
  it('lays the scene out at its grid size and places blocks in grid pixels, later blocks on top', () => {
    const { container } = render(
      <SceneRenderer
        scene={sceneOf([
          blockOf(text({ text: 'Back' }), { id: 'back', x: 0, y: 0, w: 1920, h: 1080 }),
          blockOf(text({ text: 'Badge' }), { id: 'badge', x: 1200, y: 57, w: 576, h: 135 }),
        ])}
        data={data()}
      />,
    );
    const root = container.querySelector<HTMLElement>('.sg-scene')!;
    expect(root.style.width).toBe('1920px');
    expect(root.style.height).toBe('1080px');
    const blocks = [...container.querySelectorAll<HTMLElement>('.sg-block')];
    expect(blocks.map((block) => block.dataset.blockId)).toEqual(['back', 'badge']);
    expect(blocks[1].style.left).toBe('1200px');
    expect(blocks[1].style.top).toBe('57px');
    expect(blocks[1].style.width).toBe('576px');
    expect(blocks[1].style.height).toBe('135px');
    // Document order is the stacking order: no z-index.
    expect(blocks[1].style.zIndex).toBe('');
    expect(within(blocks[1]).getByText('Badge')).toBeInTheDocument();
  });

  it('uses a short side of 1080 for portrait scenes', () => {
    const { container } = render(
      <SceneRenderer scene={scene({ main: text() }, { aspectRatio: { width: 9, height: 16 } })} data={data()} />,
    );
    const root = container.querySelector<HTMLElement>('.sg-scene')!;
    expect([root.style.width, root.style.height]).toEqual(['1080px', '1920px']);
  });

  it('leaves hidden blocks out on displays and draws them faded in the editor', () => {
    const hidden = sceneOf([
      blockOf(text({ text: 'Shown' }), { id: 'shown' }),
      blockOf(text({ text: 'Secret' }), { id: 'secret', hidden: true }),
    ]);
    const display = render(<SceneRenderer scene={hidden} data={data()} />);
    expect(display.container.querySelector('[data-block-id="secret"]')).toBeNull();
    expect(screen.queryByText('Secret')).toBeNull();
    display.unmount();
    const { container } = render(
      <SceneRenderer scene={hidden} data={data()} showHidden selectedBlockIds={['secret']} />,
    );
    const block = blockEl(container, 'secret');
    expect(block).toHaveClass('sg-block--hidden', 'sg-block--selected');
    expect(block.style.opacity).toBe('0.3');
    expect(blockEl(container, 'shown')).not.toHaveClass('sg-block--selected');
  });

  it('renders no font asset of a hidden block', () => {
    const hidden = sceneOf([
      blockOf(text(), { id: 'secret', hidden: true, style: { fontFamily: 'custom', fontAssetId: FONT } }),
    ]);
    render(<SceneRenderer scene={hidden} data={data()} />);
    const rules = [...document.head.querySelectorAll('style[data-signage-fonts]')].map((item) => item.textContent);
    expect(rules.join('\n')).not.toContain('content?v=abc');
  });
});

describe('block style', () => {
  it('maps every style field onto the block box and its content box', () => {
    const { container } = render(
      <SceneRenderer
        scene={scene(
          { main: text() },
          {},
          {
            main: {
              textColor: '#ff0000',
              backgroundColor: '#0000ff',
              backgroundOpacity: 50,
              borderColor: '#00ff00',
              borderWidth: 6,
              borderStyle: 'dashed',
              radius: 16,
              shadow: 'soft',
              padding: 33,
              textSize: 64,
              fontFamily: 'serif',
              fontWeight: '700',
              lineHeight: 140,
              letterSpacing: 5,
              uppercase: true,
              align: 'center',
              verticalAlign: 'end',
              opacity: 80,
            },
          },
        )}
        data={data()}
      />,
    );
    const block = blockEl(container);
    expect(block.style.color).toBe('rgb(255, 0, 0)');
    expect(block.style.backgroundColor).toBe('rgba(0, 0, 255, 0.5)');
    expect(block.style.border).toBe('6px dashed rgb(0, 255, 0)');
    expect(block.style.borderRadius).toBe('16px');
    expect(block.style.boxShadow).toContain('24px');
    expect(block.style.fontSize).toBe('64px');
    expect(block.style.fontFamily).toContain('IBM Plex Serif');
    expect(block.style.fontWeight).toBe('700');
    expect(block.style.lineHeight).toBe('1.4');
    expect(block.style.getPropertyValue('--sg-letter-spacing')).toBe('0.05em');
    expect(block.style.textTransform).toBe('uppercase');
    expect(block.style.textAlign).toBe('center');
    expect(block.style.opacity).toBe('0.8');
    const inner = block.querySelector<HTMLElement>('.sg-block__in')!;
    expect(inner.style.padding).toBe('33px');
    expect(inner.style.justifyContent).toBe('flex-end');
    expect(within(block).getByText('Hello')).toBeInTheDocument();
  });

  it('puts a dimmed background image under non-media widgets only', () => {
    const style = { backgroundAssetId: IMAGE, backgroundDim: 40, backgroundColor: '#112233' };
    const { container } = render(
      <SceneRenderer
        scene={sceneOf([
          blockOf(text(), { id: 'text', style }),
          blockOf({ type: 'image', mediaId: null, fit: 'cover', dim: 0 }, { id: 'image', style }),
        ])}
        data={data()}
      />,
    );
    const textBox = blockEl(container, 'text').style;
    expect(textBox.backgroundImage).toContain('rgba(0, 0, 0, 0.4)');
    expect(textBox.backgroundImage).toContain('/media/photo.png');
    expect(textBox.backgroundSize).toBe('cover');
    expect(textBox.backgroundColor).toBe('rgb(17, 34, 51)');
    const image = blockEl(container, 'image').style;
    expect(image.backgroundImage).toBe('');
    expect(image.backgroundColor).toBe('rgb(17, 34, 51)');
  });

  it('lets a glow use the border colour, else the text colour, else the theme colour', () => {
    const glow = (style: Partial<SignageBlockStyle>, theme: 'dark' | 'light' = 'dark') => {
      const { container, unmount } = render(
        <SceneRenderer
          scene={scene({ main: text() }, { theme }, { main: { shadow: 'glow', ...style } })}
          data={data()}
        />,
      );
      const value = blockEl(container).style.boxShadow;
      unmount();
      return value;
    };
    expect(glow({ borderColor: '#00ff00', textColor: '#ff0000' })).toContain('rgba(0, 255, 0, 0.7)');
    expect(glow({ textColor: '#ff0000' })).toContain('rgba(255, 0, 0, 0.7)');
    expect(glow({}, 'light')).toContain('rgba(22, 22, 22, 0.7)');
  });

  it('keeps the default look minimal: no colours, border, shadow or opacity', () => {
    const { container } = render(<SceneRenderer scene={scene({ main: { type: 'empty' } })} data={data()} />);
    const style = blockEl(container).getAttribute('style') ?? '';
    expect(style).not.toMatch(/color|border|shadow|opacity|background/);
  });

  it('sizes the widget unit --u by the text size, 32 being the default look', () => {
    const unit = (widget: SignageWidget, textSize: number) => {
      const { container, unmount } = render(
        <SceneRenderer scene={scene({ main: widget }, {}, { main: { textSize } })} data={data()} />,
      );
      const value = blockEl(container).style.getPropertyValue('--u');
      unmount();
      return value;
    };
    const clock = { type: 'clock', mode: 'time' } as SignageWidget;
    expect(unit(clock, 32)).toBe('10.8px');
    expect(unit(clock, 64)).toBe('21.6px');
    expect(unit(clock, 16)).toBe('5.4px');
    // Text and announcement blocks use the text size as their font size; their unit follows the old size "m" (50).
    expect(unit(text(), 50)).toBe('10.8px');
    expect(unit(text(), 100)).toBe('21.6px');
  });

  it('sizes announcement titles from the text size: 0.8 for banners and cards, the body 0.6 of the title', () => {
    const announcement = (style: 'banner' | 'card' | 'full') =>
      ({
        type: 'announcement',
        templateIds: [],
        style,
        whenNone: 'empty',
        fallbackText: '',
        whenMany: 'newest',
        rotateSeconds: 10,
      }) as SignageWidget;
    const sizes = (style: 'banner' | 'card' | 'full') => {
      const { container, unmount } = render(
        <SceneRenderer
          scene={scene({ main: announcement(style) }, {}, { main: { textSize: 100 } })}
          data={data({
            announcements: [{ id: 'a', templateId: 't', tone: 'info', title: 'T', body: 'B', startsAt: NOW }],
          })}
        />,
      );
      const result = [
        container.querySelector<HTMLElement>('.sg-ann__title')!.style.fontSize,
        container.querySelector<HTMLElement>('.sg-ann__body')!.style.fontSize,
      ];
      unmount();
      return result;
    };
    expect(sizes('full')).toEqual(['100px', '60px']);
    expect(sizes('banner')).toEqual(['80px', '48px']);
    expect(sizes('card')).toEqual(['80px', '48px']);
  });

  it('registers the block fonts once per document, named by the asset, and uses them in the block', () => {
    const widget = text({ fontAssetIds: [FONT] });
    const styled = scene({ main: widget }, {}, { main: { fontFamily: 'custom', fontAssetId: FONT } });
    const { container, rerender } = render(<SceneRenderer scene={styled} data={data()} />);
    rerender(<SceneRenderer scene={styled} data={data({ now: NOW + 1000 })} />);
    const rules = [...document.head.querySelectorAll('style[data-signage-fonts]')].map((item) => item.textContent);
    expect(rules).toHaveLength(1);
    expect(rules[0]).toContain('font-family: "Fira \\"Sans\\""');
    expect(rules[0]).toContain('url("/api/v1/signage/assets/font/content?v=abc")');
    expect(rules[0]).toContain('format("woff2")');
    expect(blockEl(container).style.fontFamily).toContain('Fira');
  });
});

describe('new widget fields', () => {
  const camera = (patch: Record<string, unknown>) =>
    ({
      type: 'camera',
      source: 'auto',
      machineId: null,
      multi: 'split',
      showProgress: false,
      showRemaining: false,
      showLive: true,
      showName: true,
      fallback: 'text',
      fallbackMediaId: null,
      ...patch,
    }) as SignageWidget;
  const printing = data({
    machines: [
      { machineId: 'm', name: 'Prusa', state: 'printing', progressPercent: 40, remainingMinutes: 10, stale: false },
    ],
  });

  it('shows the live badge and the machine name only when asked', () => {
    const first = render(<SceneRenderer scene={scene({ main: camera({}) })} data={printing} />);
    expect(first.container.querySelector('.sg-camera__live')).toHaveTextContent('Live');
    expect(first.container.querySelector('.sg-camera__caption')).toHaveTextContent('Prusa');
    first.unmount();
    const { container } = render(
      <SceneRenderer scene={scene({ main: camera({ showLive: false, showName: false }) })} data={printing} />,
    );
    expect(container.querySelector('.sg-camera__live')).toBeNull();
    // Nothing left for the caption: no empty gradient bar.
    expect(container.querySelector('.sg-camera__caption')).toBeNull();
  });

  it('darkens an image by its dim value', () => {
    const { container } = render(
      <SceneRenderer
        scene={scene({ main: { type: 'image', mediaId: IMAGE, fit: 'contain', dim: 35 } })}
        data={data()}
      />,
    );
    expect(container.querySelector('img')!.style.objectFit).toBe('contain');
    expect(container.querySelector<HTMLElement>('.sg-dim')!.style.background).toBe('rgba(0, 0, 0, 0.35)');
    const plain = render(
      <SceneRenderer scene={scene({ main: { type: 'image', mediaId: IMAGE, fit: 'cover', dim: 0 } })} data={data()} />,
    );
    expect(plain.container.querySelector('.sg-dim')).toBeNull();
  });
});

describe('fonts', () => {
  const fontRules = () =>
    [...document.head.querySelectorAll('style[data-signage-fonts]')].map((item) => item.textContent ?? '').join('\n');

  it('registers the font of a block style from the data the admin previews build', () => {
    const id = '0192f6f8-743e-7c77-a349-cd07c3e8f0a1';
    const preview = buildPreviewData({
      preset: 'idle',
      now: NOW,
      machines: [],
      templates: [],
      timeZone: 'Europe/Vienna',
      assets: [{ id, sha256: 'a'.repeat(64), name: 'Preview Display' }],
    });
    const { container } = render(
      <SceneRenderer
        scene={scene({ main: text() }, {}, { main: { fontFamily: 'custom', fontAssetId: id } })}
        data={preview}
      />,
    );
    expect(fontRules()).toContain(`font-family: "Preview Display"; src: url("/api/v1/signage/assets/${id}/content?v=`);
    // jsdom 31 serializes the family without the quotes the renderer writes; both name the same font.
    expect(blockEl(container).style.fontFamily).toMatch(/^"?Preview Display"?, /);
  });

  it('gives the scene root the scene font and lets blocks inherit it', () => {
    const id = '0192f6f8-743e-7c77-a349-cd07c3e8f0a2';
    const withFont = data({
      assetUrl: (asset) => (asset === id ? `/api/v1/signage/assets/${id}/content?v=abc` : null),
      assetName: (asset) => (asset === id ? 'Scene Display' : null),
    });
    const { container } = render(
      <SceneRenderer scene={scene({ main: text() }, { fontFamily: 'custom', fontAssetId: id })} data={withFont} />,
    );
    expect(fontRules()).toContain('font-family: "Scene Display"');
    expect(container.querySelector<HTMLElement>('.sg-scene')!.style.fontFamily).toMatch(/^"?Scene Display"?, /);
    expect(blockEl(container).style.fontFamily).toBe('');
  });

  it('uses the font stacks for sans, serif and mono and falls back to sans for an unknown uploaded font', () => {
    const family = (patch: Partial<RenderScene>) =>
      render(
        <SceneRenderer scene={scene({ main: text() }, patch)} data={data()} />,
      ).container.querySelector<HTMLElement>('.sg-scene')!.style.fontFamily;
    expect(family({ fontFamily: 'sans' })).toContain('IBM Plex Sans');
    expect(family({})).toContain('IBM Plex Sans');
    expect(family({ fontFamily: 'serif' })).toContain('IBM Plex Serif');
    expect(family({ fontFamily: 'mono' })).toContain('IBM Plex Mono');
    expect(family({ fontFamily: 'custom', fontAssetId: FONT.replace(/1$/, '2') })).toContain('IBM Plex Sans');
  });
});

describe('clock widget', () => {
  const clock = (mode: 'time' | 'datetime' | 'date') =>
    render(<SceneRenderer scene={scene({ main: { type: 'clock', mode } as SignageWidget })} data={data()} />).container;

  it('date mode shows weekday, day, month and year without a time', () => {
    const container = clock('date');
    expect(container.querySelector('.sg-clock')).toHaveTextContent(/Thursday,? 22 October 2026/);
    expect(container.textContent).not.toMatch(/\d\d:\d\d/);
  });

  it('keeps time and datetime unchanged', () => {
    expect(clock('time').querySelector('.sg-clock')).toHaveTextContent('12:00');
    const container = clock('datetime');
    expect(container).toHaveTextContent('12:00');
    expect(container).toHaveTextContent(/Thursday,? 22 October/);
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

  it('keeps the previous row layout without a template and the default heading', async () => {
    render(<SceneRenderer scene={scene({ main: { type: 'open_days', count: 5 } })} data={data({ openDays })} />);
    expect(await screen.findByText('Next open days')).toBeInTheDocument();
    expect(screen.getByText('Fri 23 Oct')).toBeInTheDocument();
    expect(screen.getByText('16:00–20:00')).toBeInTheDocument();
  });

  it('honours title, empty title and empty text', async () => {
    const { rerender } = render(
      <SceneRenderer
        scene={scene({ main: { type: 'events', count: 5, title: 'Soon', emptyText: 'Nothing here' } })}
        data={data()}
      />,
    );
    expect(await screen.findByText('Soon')).toBeInTheDocument();
    expect(screen.getByText('Nothing here')).toBeInTheDocument();
    rerender(<SceneRenderer scene={scene({ main: { type: 'events', count: 5, title: '' } })} data={data()} />);
    expect(await screen.findByText('No events planned')).toBeInTheDocument();
    expect(screen.queryByText('Upcoming events')).not.toBeInTheDocument();
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
    openDays: [
      { startsAt: '2026-10-23T14:00:00Z', endsAt: '2026-10-23T18:00:00Z', status: 'scheduled', competencies: [] },
    ],
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
    expect(day(container, '2026-10-23').querySelector('.sg-cal__time')).toHaveTextContent('16:00–20:00');
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

  it('leaves out the legend when hideLegend is set', async () => {
    const { container } = render(
      <SceneRenderer scene={scene({ main: widget({ hideLegend: true }) })} data={data({ calendar })} />,
    );
    await ready();
    expect(container.querySelector('.sg-cal__day')).not.toBeNull();
    expect(container.querySelector('.sg-cal__legend')).toBeNull();
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
