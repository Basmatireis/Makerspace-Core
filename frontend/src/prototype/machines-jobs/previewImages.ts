import type { PrintPreview } from './types';

// Mock 3MF previews: inline SVG data URIs, no files and no network. The shapes only suggest a print plate
// with the run's filament colours; the real backend serves the thumbnails stored inside the 3MF.

const COLOR_WORDS: [string, string][] = [
  ['black', '#3a3a40'], ['white', '#f4f4f4'], ['grey', '#8d8d8d'], ['gray', '#8d8d8d'], ['red', '#da1e28'], ['blue', '#4589ff'],
  ['green', '#24a148'], ['orange', '#ff832b'], ['yellow', '#f1c21b'], ['clear', '#a6c8ff'], ['natural', '#e8dcc0'],
];
const PICK_COLORS = ['#ff4d4d', '#4dff88', '#4d9bff', '#ffe14d', '#ff4dff'];

export const filamentColor = (materialName: string) => COLOR_WORDS.find(([word]) => materialName.toLowerCase().includes(word))?.[1] ?? '#78a9ff';

const clamp = (value: number) => Math.max(0, Math.min(255, Math.round(value)));
/** Positive factor lightens, negative darkens. */
function shade(hex: string, factor: number) {
  const channels = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  return `#${channels.map((c) => clamp(factor >= 0 ? c + (255 - c) * factor : c * (1 + factor)).toString(16).padStart(2, '0')).join('')}`;
}

const SLOTS: [number, number][] = [[200, 150], [150, 125], [250, 125], [150, 175], [250, 175]];

function objects(plate: number, count: number) {
  return SLOTS.slice(0, count).map(([x, y], index) => ({ x, y, size: 26 + ((plate + index) % 3) * 6, height: 14 + ((plate * 3 + index * 5) % 4) * 8, round: (plate + index) % 4 === 3 }));
}

function iso(x: number, y: number, size: number, height: number, color: string) {
  const dx = size;
  const dy = size / 2;
  const top = `${x},${y - height - dy} ${x + dx},${y - height} ${x},${y - height + dy} ${x - dx},${y - height}`;
  const left = `${x - dx},${y - height} ${x},${y - height + dy} ${x},${y + dy} ${x - dx},${y}`;
  const right = `${x},${y - height + dy} ${x + dx},${y - height} ${x + dx},${y} ${x},${y + dy}`;
  return `<polygon points="${left}" fill="${shade(color, -0.35)}"/><polygon points="${right}" fill="${shade(color, -0.15)}"/><polygon points="${top}" fill="${shade(color, 0.12)}"/>`;
}

function body(role: PrintPreview['role'], plate: number, colors: string[]) {
  const shapes = objects(plate, 3 + (plate % 3));
  if (role === 'plate') {
    const bed = '<polygon points="200,55 350,130 200,205 50,130" fill="#4a4f58" stroke="#8d96a3" stroke-width="2"/><polygon points="200,205 350,130 350,140 200,215 50,140 50,130" fill="#2f333a"/>';
    return bed + [...shapes].sort((a, b) => a.y - b.y).map((shape, index) => iso(shape.x, shape.y - 30, shape.size * 0.8, shape.height, colors[index % colors.length])).join('');
  }
  if (role === 'top') {
    const bed = '<rect x="60" y="40" width="280" height="200" rx="4" fill="#3a3f47" stroke="#8d96a3" stroke-width="2"/>';
    return bed + shapes.map((shape, index) => {
      const color = colors[index % colors.length];
      const px = shape.x + (index % 2 ? 10 : -10);
      const py = shape.y - 20;
      return shape.round
        ? `<circle cx="${px}" cy="${py}" r="${shape.size * 0.8}" fill="${color}" stroke="${shade(color, -0.4)}" stroke-width="2"/>`
        : `<rect x="${px - shape.size}" y="${py - shape.size * 0.7}" width="${shape.size * 2}" height="${shape.size * 1.4}" rx="3" fill="${color}" stroke="${shade(color, -0.4)}" stroke-width="2"/>`;
    }).join('');
  }
  return shapes.map((shape, index) => {
    const px = shape.x + (index % 2 ? 10 : -10);
    const py = shape.y - 20;
    return shape.round
      ? `<circle cx="${px}" cy="${py}" r="${shape.size * 0.8}" fill="${PICK_COLORS[index % PICK_COLORS.length]}"/>`
      : `<rect x="${px - shape.size}" y="${py - shape.size * 0.7}" width="${shape.size * 2}" height="${shape.size * 1.4}" rx="3" fill="${PICK_COLORS[index % PICK_COLORS.length]}"/>`;
  }).join('');
}

export function previewImage(role: PrintPreview['role'], plate: number, colors: string[]) {
  const background = role === 'pick'
    ? '<rect width="400" height="300" fill="#121416"/>'
    : '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2d3138"/><stop offset="1" stop-color="#1b1d21"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/>';
  const label = role === 'pick' ? `Pick map · plate ${plate}` : `Plate ${plate}`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">${background}${body(role, plate, colors.length ? colors : ['#78a9ff'])}<text x="16" y="284" fill="#c6c6c6" font-family="sans-serif" font-size="16">${label}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/** The previews a parsed 3MF would yield: per plate its render, plus top and pick views of the first plate. */
export function makePreviews(runId: string, materialNames: string[], plates: number): PrintPreview[] {
  const colors = materialNames.map(filamentColor);
  const list: PrintPreview[] = [];
  for (let plate = 1; plate <= plates; plate += 1) {
    list.push({ id: `${runId}-plate-${plate}`, role: 'plate', label: plates > 1 ? `Plate ${plate}` : 'Plate', src: previewImage('plate', plate, colors) });
  }
  list.push({ id: `${runId}-top`, role: 'top', label: 'Top view', src: previewImage('top', 1, colors) });
  list.push({ id: `${runId}-pick`, role: 'pick', label: 'Objects', src: previewImage('pick', 1, colors) });
  return list;
}
