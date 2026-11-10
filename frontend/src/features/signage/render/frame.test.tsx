import { render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { frameScale, sceneGridSize } from './aspect';
import { ScreenFrame } from './SceneRenderer';
import { blockUnit } from './style';

describe('scene grid', () => {
  it('gives the short side 1080 units and rounds the long side like the server', () => {
    expect(sceneGridSize({ width: 16, height: 9 })).toEqual({ width: 1920, height: 1080 });
    expect(sceneGridSize({ width: 9, height: 16 })).toEqual({ width: 1080, height: 1920 });
    expect(sceneGridSize({ width: 21, height: 9 })).toEqual({ width: 2520, height: 1080 });
    expect(sceneGridSize({ width: 4, height: 3 })).toEqual({ width: 1440, height: 1080 });
    expect(sceneGridSize({ width: 1, height: 1 })).toEqual({ width: 1080, height: 1080 });
    expect(sceneGridSize({ width: 3, height: 5 })).toEqual({ width: 1080, height: 1800 });
    // 1080 · 17 / 7 = 2622.86 rounds up.
    expect(sceneGridSize({ width: 17, height: 7 })).toEqual({ width: 2623, height: 1080 });
  });
});

describe('widget unit', () => {
  it('is 10.8 px at the default text size 32 and scales with it', () => {
    expect(blockUnit('clock', 32)).toBe(10.8);
    expect(blockUnit('calendar', 48)).toBe(16.2);
    expect(blockUnit('status', 8)).toBe(2.7);
    expect(blockUnit('announcement', 50)).toBe(10.8);
    expect(blockUnit('text', 76)).toBe(16.416);
  });
});

describe('ScreenFrame scale', () => {
  it('fits the grid into the box', () => {
    expect(frameScale(960, 540, 1920, 1080)).toBe(0.5);
    expect(frameScale(480, 1000, 1920, 1080)).toBe(0.25);
    expect(frameScale(3840, 2160, 1920, 1080)).toBe(2);
    // Only a width (no height yet): the width decides.
    expect(frameScale(270, 0, 1080, 1920)).toBe(0.25);
    expect(frameScale(0, 0, 1920, 1080)).toBe(0);
  });

  describe('component', () => {
    const spies: { mockRestore: () => void }[] = [];
    afterEach(() => spies.splice(0).forEach((spy) => spy.mockRestore()));
    const box = (width: number, height: number) =>
      spies.push(
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
          return this.classList.contains('sg-frame') ? width : 0;
        }),
        vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) {
          return this.classList.contains('sg-frame') ? height : 0;
        }),
      );

    it('lays out a stage of the grid size and scales it to the measured box with a transform', () => {
      box(480, 270);
      const onScaleChange = vi.fn();
      const { container } = render(
        <ScreenFrame aspectRatio={{ width: 16, height: 9 }} width="480px" onScaleChange={onScaleChange}>
          <span>child</span>
        </ScreenFrame>,
      );
      const frame = container.querySelector<HTMLElement>('.sg-frame')!;
      const stage = container.querySelector<HTMLElement>('.sg-stage')!;
      expect(frame.style.aspectRatio).toBe('16 / 9');
      expect(frame.style.inlineSize).toBe('480px');
      expect([stage.style.width, stage.style.height]).toEqual(['1920px', '1080px']);
      expect(stage.style.transform).toBe('scale(0.25)');
      expect(stage.style.willChange).toBe('');
      expect(onScaleChange).toHaveBeenCalledWith(0.25);
    });

    it('uses a fixed scale (editor zoom) and sizes the box to the scaled grid', () => {
      const { container } = render(
        <ScreenFrame aspectRatio={{ width: 9, height: 16 }} scale={0.5}>
          <span>child</span>
        </ScreenFrame>,
      );
      const frame = container.querySelector<HTMLElement>('.sg-frame')!;
      expect([frame.style.inlineSize, frame.style.blockSize]).toEqual(['540px', '960px']);
      expect(container.querySelector<HTMLElement>('.sg-stage')!.style.transform).toBe('scale(0.5)');
    });
  });
});
