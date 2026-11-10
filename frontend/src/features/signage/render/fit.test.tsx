import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { blockOverflows, contentOverflows, fitTextSize, overflowingBlockIds } from './fit';
import { SceneRenderer } from './SceneRenderer';
import { blockOf, sceneOf } from './testScenes';
import type { RenderData } from './types';

// jsdom has no layout, so these tests give elements layout boxes: a text box is `lines × fontSize × 1.2` high, where
// the number of lines grows when the text is wider than its block.

const data: RenderData = {
  now: 0,
  liveAvailable: true,
  machines: [],
  announcements: [],
  openDays: [],
  events: [],
  assetUrl: () => null,
};

type Box = { offsetTop?: number; offsetLeft?: number; offsetWidth?: number; offsetHeight?: number };

function stubLayout(measure: (element: HTMLElement) => Box & { clientWidth?: number; clientHeight?: number }) {
  const spies = (
    ['offsetTop', 'offsetLeft', 'offsetWidth', 'offsetHeight', 'clientWidth', 'clientHeight'] as const
  ).map((key) =>
    vi.spyOn(HTMLElement.prototype, key, 'get').mockImplementation(function (this: HTMLElement) {
      return measure(this)[key] ?? 0;
    }),
  );
  return () => spies.forEach((spy) => spy.mockRestore());
}

describe('fitTextSize', () => {
  it('returns the largest integer size that fits, the maximum when it fits, and the minimum when nothing does', () => {
    expect(fitTextSize(120, (size) => size <= 73)).toBe(73);
    expect(fitTextSize(120, () => true)).toBe(120);
    expect(fitTextSize(120, () => false)).toBe(8);
    expect(fitTextSize(60.7, (size) => size <= 59)).toBe(59);
  });

  it('is deterministic and needs at most ten measurements for the largest text size', () => {
    const calls: number[] = [];
    const fits = (size: number) => {
      calls.push(size);
      return size <= 137;
    };
    const first = fitTextSize(400, fits);
    const sequence = [...calls];
    calls.length = 0;
    expect(fitTextSize(400, fits)).toBe(first);
    expect(calls).toEqual(sequence);
    expect(first).toBe(137);
    expect(sequence.length).toBeLessThanOrEqual(10);
  });
});

describe('overflow detection (layout boxes)', () => {
  let restore = () => {};
  afterEach(() => restore());

  const inner = (children: Box[], padding = 10, width = 300, height = 200) => {
    const element = document.createElement('div');
    element.style.padding = `${padding}px`;
    const boxes = new Map<Element, Box>();
    for (const box of children) {
      const child = document.createElement('div');
      element.append(child);
      boxes.set(child, box);
    }
    document.body.append(element);
    restore = stubLayout((target) =>
      target === element ? { clientWidth: width, clientHeight: height } : (boxes.get(target) ?? {}),
    );
    return element;
  };

  it('accepts content inside the padding box, within a pixel', () => {
    expect(contentOverflows(inner([{ offsetTop: 10, offsetLeft: 10, offsetWidth: 280, offsetHeight: 181 }]))).toBe(
      false,
    );
  });

  it('flags content below the bottom padding, above the top padding (centred and too tall) or too wide', () => {
    expect(contentOverflows(inner([{ offsetTop: 10, offsetLeft: 10, offsetWidth: 280, offsetHeight: 190 }]))).toBe(
      true,
    );
    expect(contentOverflows(inner([{ offsetTop: -20, offsetLeft: 10, offsetWidth: 280, offsetHeight: 240 }]))).toBe(
      true,
    );
    expect(contentOverflows(inner([{ offsetTop: 10, offsetLeft: 10, offsetWidth: 300, offsetHeight: 20 }]))).toBe(true);
  });
});

describe('shrink text to fit in the renderer', () => {
  let restore = () => {};
  afterEach(() => restore());

  /** A block 400 wide and 200 high (no padding); text 20 characters per 400 px at size 20, line height 1.2. */
  const layout = () =>
    stubLayout((element) => {
      if (element.classList.contains('sg-block__in')) return { clientWidth: 400, clientHeight: 200 };
      if (!element.classList.contains('sg-text')) return {};
      const size = parseFloat(element.style.fontSize || element.parentElement!.parentElement!.style.fontSize);
      const perLine = Math.max(1, Math.floor(400 / (size * 0.5)));
      const lines = Math.ceil((element.textContent ?? '').length / perLine);
      return { offsetTop: 0, offsetLeft: 0, offsetWidth: 400, offsetHeight: Math.ceil(lines * size * 1.2) };
    });

  const scene = (fit: boolean) =>
    sceneOf([
      blockOf(
        { type: 'text', text: 'A'.repeat(120), fit },
        { id: 'text', w: 400, h: 200, style: { textSize: 100, padding: 0, verticalAlign: 'start' } },
      ),
    ]);

  it('shrinks to the same integer size on every render and reports no overflow afterwards', () => {
    restore = layout();
    const first = render(<SceneRenderer scene={scene(true)} data={data} />);
    const size = first.container.querySelector<HTMLElement>('.sg-text')!.style.fontSize;
    expect(size).toMatch(/^\d+px$/);
    expect(parseFloat(size)).toBeLessThan(100);
    expect(overflowingBlockIds(first.container)).toEqual([]);
    first.unmount();
    const second = render(<SceneRenderer scene={scene(true)} data={data} />);
    expect(second.container.querySelector<HTMLElement>('.sg-text')!.style.fontSize).toBe(size);
  });

  it('leaves the text size alone without fit, where the block is flagged as overflowing', () => {
    restore = layout();
    const { container } = render(<SceneRenderer scene={scene(false)} data={data} />);
    expect(container.querySelector<HTMLElement>('.sg-text')!.style.fontSize).toBe('');
    expect(blockOverflows(container.querySelector('[data-block-id="text"]')!)).toBe(true);
    expect(overflowingBlockIds(container)).toEqual(['text']);
  });

  it('never flags an empty block', () => {
    restore = layout();
    const { container } = render(
      <SceneRenderer scene={sceneOf([blockOf({ type: 'empty' }, { id: 'empty' })])} data={data} />,
    );
    expect(overflowingBlockIds(container)).toEqual([]);
  });
});
