import { describe, expect, it } from 'vitest';
import type { SignageBlock, SignageWidget } from '../../api/generated/models';
import { readableOn, widgetColorCss } from './render/style';
import { toDraft } from './sceneDraft';
import { sceneFixture } from './testFixtures';
import { block } from './editor/testBlocks';
import { defaultWidget } from './widgets';
import { replaceScreenColor, screenColors } from './widgetColors';

const red = '#da1e28';
const blue = '#0f62fe';

function draftWith(blocks: SignageBlock[]) {
  return toDraft(sceneFixture({ backgroundColor: '#161616', blocks }));
}

describe('screen colours', () => {
  const status = { ...defaultWidget('status'), busyColor: red } as SignageWidget;
  const blocks = [block('a', 0, 0, 100, 100, {}, 'text'), block('b', 0, 0, 100, 100, { widget: status }, 'status')];
  blocks[0] = { ...blocks[0], style: { ...blocks[0].style, backgroundColor: red, borderColor: blue } };

  it('lists every colour set on the screen with how often it is used, most used first', () => {
    expect(screenColors(draftWith(blocks))).toEqual([
      { color: red, count: 2 },
      { color: '#161616', count: 1 },
      { color: blue, count: 1 },
    ]);
  });

  it('replaces a colour everywhere it is used and leaves the others', () => {
    const next = replaceScreenColor(draftWith(blocks), red, '#00ff00');
    expect(next.blocks[0].style.backgroundColor).toBe('#00ff00');
    expect(next.blocks[0].style.borderColor).toBe(blue);
    expect((next.blocks[1].widget as { busyColor?: string }).busyColor).toBe('#00ff00');
    expect(next.backgroundColor).toBe('#161616');
  });

  it('leaves transparent out of the screen colours', () => {
    const qr = { ...defaultWidget('qr'), lightColor: 'transparent' } as SignageWidget;
    const draft = draftWith([block('q', 0, 0, 100, 100, { widget: qr }, 'qr')]);
    expect(screenColors(draft).map((item) => item.color)).toEqual(['#161616']);
  });

  it('includes the calendar categories', () => {
    const calendar = block('c', 0, 0, 100, 100, {}, 'calendar');
    const draft = draftWith([calendar]);
    const holiday = calendar.widget.type === 'calendar' ? calendar.widget.colors.holiday : '';
    const next = replaceScreenColor(draft, holiday, '#123456');
    expect(next.blocks[0].widget.type === 'calendar' && next.blocks[0].widget.colors.holiday).toBe('#123456');
  });
});

describe('widget colour properties', () => {
  it('sets only the colours a widget has, with readable text on badges', () => {
    const status = { ...defaultWidget('status'), busyColor: '#ffffff', progressColor: blue } as SignageWidget;
    expect(widgetColorCss(status)).toEqual({
      '--sg-busy': '#ffffff',
      '--sg-busy-text': '#161616',
      '--sg-progress': blue,
    });
    expect(widgetColorCss(defaultWidget('status'))).toEqual({});
    expect(readableOn('#161616')).toBe('#ffffff');
  });
});
