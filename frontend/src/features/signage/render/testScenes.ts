import type { SignageBlock, SignageBlockStyle, SignageWidget } from '../../../api/generated/models';
import { defaultBlockStyle } from '../widgets';
import type { RenderScene } from './types';

// Scene builders for renderer tests.

/** A block with the default style of its widget; `patch.style` is merged into that style. */
export const blockOf = (
  widget: SignageWidget,
  patch: Partial<Omit<SignageBlock, 'style'>> & { style?: Partial<SignageBlockStyle> } = {},
): SignageBlock => {
  const { style, ...rest } = patch;
  return {
    id: 'main',
    name: 'Main',
    x: 0,
    y: 0,
    w: 1920,
    h: 1080,
    hidden: false,
    locked: false,
    widget,
    ...rest,
    style: { ...defaultBlockStyle(widget.type), ...style },
  };
};

/** A dark 16:9 scene (1920 × 1080 grid) with the given blocks. */
export const sceneOf = (blocks: SignageBlock[], patch: Partial<RenderScene> = {}): RenderScene => ({
  aspectRatio: { width: 16, height: 9 },
  backgroundColor: '#161616',
  backgroundAssetId: null,
  backgroundFit: 'cover',
  backgroundDim: 0,
  theme: 'dark',
  blocks,
  ...patch,
});

/** A scene with one full-screen block showing `widget`. */
export const sceneWith = (widget: SignageWidget, patch: Partial<RenderScene> = {}): RenderScene =>
  sceneOf([blockOf(widget)], patch);
