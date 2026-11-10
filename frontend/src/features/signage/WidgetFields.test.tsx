import { useState } from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SignageWidget } from '../../api/generated/models';
import { renderRoute } from '../../test/render';
import { assetFixture, ids, mockSignage } from './testFixtures';
import { WidgetFields } from './WidgetFields';
import { defaultWidget, widgetAssetIds, widgetError } from './widgets';

vi.mock('../auth/auth', () => ({
  useCurrentUser: () => ({ permissions: [], authentication: { reauthenticationRequired: [] } }),
}));

const font = assetFixture({ id: ids.video, kind: 'font', name: 'Space Grotesk', contentType: 'font/woff2' });

/** Holds the widget like the scene editor does and exposes the latest value to the test. */
function Harness({ initial, onWidget }: { initial: SignageWidget; onWidget: (widget: SignageWidget) => void }) {
  const [widget, setWidget] = useState(initial);
  return (
    <WidgetFields
      widget={widget}
      assets={[assetFixture(), font]}
      templates={[]}
      machines={[]}
      outsideDisplays={[]}
      onChange={(next) => {
        setWidget(next);
        onWidget(next);
      }}
    />
  );
}

function setup(initial: SignageWidget) {
  const seen: { current: SignageWidget } = { current: initial };
  mockSignage([]);
  renderRoute(<Harness initial={initial} onWidget={(widget) => (seen.current = widget)} />);
  return seen;
}

describe('Widget fields', () => {
  it('edits the image: fit and darken, and switches camera overlays', async () => {
    const seen = setup(defaultWidget('image'));
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Fit'), 'contain');
    fireEvent.change(screen.getByLabelText('Darken image', { selector: 'input[type="number"]' }), {
      target: { value: '40' },
    });
    expect(seen.current).toMatchObject({ type: 'image', fit: 'contain', dim: 40 });
    expect(widgetError(seen.current)).toBeNull();
  });

  it('switches the live picture and the machine name of a camera', async () => {
    const seen = setup(defaultWidget('camera'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('switch', { name: 'Show the live picture' }));
    await user.click(screen.getByRole('switch', { name: 'Show the machine name' }));
    expect(seen.current).toMatchObject({ showLive: false, showName: false, showProgress: true });
  });

  it('orders and removes slides and adds one from Media', async () => {
    const second = '0192f6f8-743e-7c77-a349-cd07c3e8a199';
    const seen = setup({ ...defaultWidget('slideshow'), mediaIds: [ids.asset, second] } as SignageWidget);
    const user = userEvent.setup();
    await user.click(screen.getAllByRole('button', { name: 'Move down' })[0]);
    expect(seen.current).toMatchObject({ mediaIds: [second, ids.asset] });
    await user.click(screen.getAllByRole('button', { name: 'Remove slide' })[0]);
    expect(seen.current).toMatchObject({ mediaIds: [ids.asset] });
    await user.click(await screen.findByRole('combobox', { name: 'Add slide' }));
    await user.click(await screen.findByRole('option', { name: 'poster.png' }));
    expect(seen.current).toMatchObject({ mediaIds: [ids.asset, ids.asset] });
  });

  it('has no size or style fields: those live in the style sections', () => {
    setup(defaultWidget('text'));
    expect(screen.queryByLabelText('Text size')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Alignment')).not.toBeInTheDocument();
  });

  it('sets the text format, CSS and fonts used in CSS', async () => {
    const seen = setup(defaultWidget('text'));
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Format'), 'markdown');
    expect(seen.current).toMatchObject({ type: 'text', format: 'markdown' });
    await user.selectOptions(screen.getByLabelText('Format'), 'plain');
    expect('format' in seen.current).toBe(false);
    await user.click(screen.getByRole('button', { name: 'CSS and fonts' }));
    fireEvent.change(screen.getByLabelText('CSS'), { target: { value: 'h1 { color: red; }' } });
    await user.click(screen.getByRole('combobox', { name: /Fonts used in CSS/ }));
    await user.click(await screen.findByRole('option', { name: 'Space Grotesk' }));
    expect(seen.current).toMatchObject({ css: 'h1 { color: red; }', fontAssetIds: [ids.video] });
    expect(widgetAssetIds(seen.current)).toEqual([ids.video]);
  });

  it('accepts text up to 20 000 characters and rejects more', () => {
    const long = { ...defaultWidget('text'), text: 'x'.repeat(20000) } as SignageWidget;
    expect(widgetError(long)).toBeNull();
    expect(widgetError({ ...long, text: 'x'.repeat(20001) } as SignageWidget)).toMatch(/20000/);
  });

  it('edits list heading, empty text and entry template with clickable placeholders', async () => {
    const seen = setup(defaultWidget('open_days'));
    const user = userEvent.setup();
    fireEvent.change(screen.getByLabelText('Show the next … open days'), { target: { value: '12' } });
    expect(seen.current).toMatchObject({ count: 12 });
    expect(widgetError(seen.current)).toBeNull();
    await user.selectOptions(screen.getByLabelText('Heading'), 'none');
    expect(seen.current).toMatchObject({ title: '' });
    await user.selectOptions(screen.getByLabelText('Heading'), 'default');
    expect('title' in seen.current).toBe(false);
    fireEvent.change(screen.getByLabelText('Text when there is nothing to show'), { target: { value: 'Closed' } });
    const template = screen.getByLabelText('Entry template');
    fireEvent.change(template, { target: { value: '<b></b>' } });
    (template as HTMLTextAreaElement).setSelectionRange(3, 3);
    fireEvent.select(template);
    const tags = screen.getByRole('group', { name: 'Placeholders for Entry template' });
    expect(within(tags).queryByText('{location}')).not.toBeInTheDocument();
    await user.click(within(tags).getByText('{date}'));
    expect(seen.current).toMatchObject({ emptyText: 'Closed', entryTemplate: '<b>{date}</b>' });
    fireEvent.change(screen.getByLabelText('Show the next … open days'), { target: { value: '21' } });
    expect(widgetError(seen.current)).toBeNull();
  });

  it('rejects list counts above 20', () => {
    expect(widgetError({ ...defaultWidget('events'), count: 21 } as SignageWidget)).toMatch(/20/);
    expect(widgetError({ ...defaultWidget('agenda'), count: 20 } as SignageWidget)).toBeNull();
  });

  it('builds an agenda with one template per kind', async () => {
    const seen = setup(defaultWidget('agenda'));
    const user = userEvent.setup();
    expect(seen.current).toMatchObject({ type: 'agenda', includeOpenDays: true, includeEvents: true });
    await user.click(screen.getByLabelText('Events'));
    expect(seen.current).toMatchObject({ includeEvents: false });
    fireEvent.change(screen.getByLabelText('Open day template'), { target: { value: '{date} open' } });
    fireEvent.change(screen.getByLabelText('Event template'), { target: { value: '{title} at {location}' } });
    expect(seen.current).toMatchObject({ openDayTemplate: '{date} open', eventTemplate: '{title} at {location}' });
    expect(widgetError(seen.current)).toBeNull();
    const tags = screen.getByRole('group', { name: 'Placeholders for Open day template' });
    expect(within(tags).getByText('{status}')).toBeInTheDocument();
    expect(within(tags).queryByText('{location}')).not.toBeInTheDocument();
  });

  it('configures the calendar: view, weeks, categories, colours and week numbers', async () => {
    const seen = setup(defaultWidget('calendar'));
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Next weeks'));
    fireEvent.change(screen.getByLabelText('Weeks to show'), { target: { value: '9' } });
    expect(seen.current).toMatchObject({ view: 'weeks', weeks: 6 });
    await user.click(screen.getByRole('switch', { name: 'Holidays' }));
    await user.click(screen.getByRole('switch', { name: 'Week numbers' }));
    fireEvent.change(screen.getByLabelText('Events colour'), { target: { value: '#AA00FF' } });
    fireEvent.change(screen.getByLabelText('Title (optional)'), { target: { value: 'Coming up' } });
    expect(seen.current).toMatchObject({
      showHolidays: false,
      showWeekNumbers: true,
      title: 'Coming up',
      colors: { event: '#aa00ff', holiday: '#fa4d56' },
    });
    expect(widgetError(seen.current)).toBeNull();
    expect(widgetError({ ...(seen.current as object), weeks: 7 } as SignageWidget)).toMatch(/1 and 6/);
  });

  it('switches planned competencies on and drops the field again when off', async () => {
    const user = userEvent.setup();
    const seen = setup(defaultWidget('open_days'));
    expect(seen.current).not.toHaveProperty('showCompetencies');
    await user.click(screen.getByLabelText('Show planned competencies'));
    expect(seen.current).toMatchObject({ showCompetencies: true });
    await user.click(screen.getByLabelText('Show planned competencies'));
    expect(seen.current).not.toHaveProperty('showCompetencies');
  });

  it('offers no competencies for events', () => {
    setup(defaultWidget('events'));
    expect(screen.queryByLabelText('Show planned competencies')).not.toBeInTheDocument();
  });

  it('offers calendar competencies only for open days in the weeks view', async () => {
    const user = userEvent.setup();
    const seen = setup({ ...defaultWidget('calendar'), view: 'weeks', showOpenDays: true } as SignageWidget);
    await user.click(screen.getByRole('switch', { name: 'Planned competencies on open days' }));
    expect(seen.current).toMatchObject({ showCompetencies: true });
  });
});

describe('Timelapse widget', () => {
  const machine = '0192f6f8-743e-7c77-a349-cd07c3e8a001';
  const timelapse = (patch: Record<string, unknown> = {}) =>
    ({ ...defaultWidget('timelapse'), ...patch }) as SignageWidget;

  it('starts valid and checks machines and ranges like the backend', () => {
    expect(defaultWidget('timelapse')).toEqual({
      type: 'timelapse',
      source: 'all',
      machineIds: [],
      count: 5,
      maxAgeDays: 30,
      maxSeconds: 30,
      transition: 'fade',
      showCaption: true,
      fit: 'cover',
    });
    expect(widgetError(timelapse())).toBeNull();
    expect(widgetError(timelapse({ source: 'machines' }))).toBe('Choose at least one machine.');
    expect(widgetError(timelapse({ source: 'machines', machineIds: [machine] }))).toBeNull();
    expect(widgetError(timelapse({ source: 'machines', machineIds: [machine, machine] }))).toMatch(/once/);
    expect(widgetError(timelapse({ machineIds: [machine] }))).not.toBeNull();
    const many = Array.from({ length: 21 }, (_, index) => `${machine.slice(0, -2)}${String(index).padStart(2, '0')}`);
    expect(widgetError(timelapse({ source: 'machines', machineIds: many }))).toMatch(/at most 20/);
    expect(widgetError(timelapse({ count: 0 }))).not.toBeNull();
    expect(widgetError(timelapse({ count: 21 }))).not.toBeNull();
    expect(widgetError(timelapse({ maxAgeDays: 0 }))).toBeNull();
    expect(widgetError(timelapse({ maxAgeDays: 366 }))).not.toBeNull();
    expect(widgetError(timelapse({ maxSeconds: 4 }))).not.toBeNull();
    expect(widgetError(timelapse({ maxSeconds: 601 }))).not.toBeNull();
  });

  it('edits the clip settings and clears the machines when all machines are chosen', async () => {
    const seen = setup(timelapse({ source: 'machines', machineIds: [machine] }));
    const user = userEvent.setup();
    expect(screen.getByText(/this editor preview stays empty/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Number of clips'), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText('Maximum age in days'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Maximum seconds per clip'), { target: { value: '45' } });
    await user.selectOptions(screen.getByLabelText('Transition'), 'cut');
    await user.click(screen.getByRole('switch', { name: /Caption with machine and day/ }));
    await user.click(screen.getByText('All machines'));
    expect(seen.current).toMatchObject({
      source: 'all',
      machineIds: [],
      count: 8,
      maxAgeDays: 0,
      maxSeconds: 45,
      transition: 'cut',
      showCaption: false,
    });
  });
});
