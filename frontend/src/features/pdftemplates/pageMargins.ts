import type { PaperSize } from './model';

/** Body margins that suit each paper (top, right, bottom, left in mm), applied when the paper's width changes a lot. */
export const PAPER_MARGINS: Record<Exclude<PaperSize, 'custom'>, [number, number, number, number]> = {
  A3: [30, 20, 22, 20],
  A4: [30, 20, 22, 20],
  A5: [22, 12, 16, 12],
  A6: [14, 8, 10, 8],
  Letter: [30, 20, 22, 20],
  Legal: [30, 20, 22, 20],
  DL: [14, 10, 12, 10],
  L62: [4, 4, 4, 4],
  L102: [6, 6, 6, 6],
  L54: [4, 4, 4, 4],
};
