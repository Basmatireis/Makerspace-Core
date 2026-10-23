import { useState } from 'react';
import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SignageWidget } from '../../api/generated/models';
import { renderRoute } from '../../test/render';
import { assetFixture, ids } from './testFixtures';
import { WidgetFields } from './WidgetFields';
import { defaultWidget, sceneAssetIds, styleOf, widgetAssetIds, widgetError } from './widgets';

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
  renderRoute(<Harness initial={initial} onWidget={(widget) => (seen.current = widget)} />);
  return seen;
}

describe('Widget fields', () => {
  it('writes a complete, valid style object and removes it again on reset', async () => {
    const seen = setup(defaultWidget('text'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Style' }));
    fireEvent.change(screen.getByLabelText('Zone text colour'), { target: { value: '#FFAA00' } });
    fireEvent.change(screen.getByLabelText('Zone background colour'), { target: { value: '#112233' } });
    fireEvent.change(screen.getByLabelText('Padding'), { target: { value: '3' } });
    fireEvent.change(screen.getByLabelText('Font size (%)'), { target: { value: '150' } });
    await user.selectOptions(screen.getByLabelText('Horizontal alignment'), 'center');
    const style = styleOf(seen.current);
    expect(style).toEqual({
      textColor: '#ffaa00',
      backgroundColor: '#112233',
      borderColor: null,
      backgroundOpacity: 100,
      padding: 3,
      radius: 0,
      borderWidth: 0,
      fontScale: 150,
      fontFamily: 'inherit',
      fontAssetId: null,
      align: 'center',
      verticalAlign: 'inherit',
    });
    expect(widgetError(seen.current)).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Reset style' }));
    expect(styleOf(seen.current)).toBeUndefined();
  });

  it('keeps an incomplete colour out of the widget and flags it', () => {
    const seen = setup(defaultWidget('text'));
    fireEvent.change(screen.getByLabelText('Zone text colour'), { target: { value: '#12' } });
    expect(screen.getAllByText('Enter a hex colour like #161616').length).toBeGreaterThan(0);
    expect(styleOf(seen.current)).toBeUndefined();
  });

  it('needs an uploaded font for the custom family and references it for the font protection', async () => {
    const seen = setup(defaultWidget('empty'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Style' }));
    await user.selectOptions(screen.getByLabelText('Font family'), 'custom');
    expect(widgetError(seen.current)).toMatch(/font/i);
    await user.click(screen.getByRole('combobox', { name: 'Font' }));
    await user.click(await screen.findByRole('option', { name: 'Space Grotesk' }));
    expect(styleOf(seen.current)).toMatchObject({ fontFamily: 'custom', fontAssetId: ids.video });
    expect(widgetError(seen.current)).toBeNull();
    expect(widgetAssetIds(seen.current)).toEqual([ids.video]);
  });

  it('stores the announcement box style in boxStyle and leaves its presentation style alone', async () => {
    const seen = setup(defaultWidget('announcement'));
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Style' }));
    fireEvent.change(screen.getByLabelText('Zone background colour'), { target: { value: '#000000' } });
    const widget = seen.current;
    expect(widget.type === 'announcement' && widget.style).toBe('banner');
    expect(widget.type === 'announcement' && widget.boxStyle?.backgroundColor).toBe('#000000');
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
    expect(sceneAssetIds({ backgroundAssetId: null, zones: { main: seen.current } })).toEqual([ids.video]);
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
