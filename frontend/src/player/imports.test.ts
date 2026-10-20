import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The player is a separate small app (docs/signage.md, "Player app"): its runtime import graph may contain only React,
// the player's own files and the shared signage engine, renderer and layouts. Type-only imports are erased and ignored.

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(SRC, 'player/main.tsx');
const ALLOWED_PACKAGES = new Set(['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']);
const ALLOWED_SHARED = [
  /^features\/signage\/engine\//,
  /^features\/signage\/render\//,
  /^features\/signage\/layouts\.ts$/,
];

const resolveFile = (from: string, specifier: string): string | null => {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
};

function runtimeImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/^\s*(?:import|export)\s+(?!type\s)[^'"]*?from\s+['"]([^'"]+)['"]/gm))
    specifiers.push(match[1]);
  for (const match of source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specifiers.push(match[1]);
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]);
  return specifiers;
}

function importGraph() {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [ENTRY];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeImports(readFileSync(file, 'utf8'))) {
      if (specifier.startsWith('.')) {
        const target = resolveFile(file, specifier);
        if (target === null) throw new Error(`Cannot resolve ${specifier} from ${relative(SRC, file)}`);
        if (/\.(css|scss)$/.test(target)) {
          files.add(target);
          continue;
        }
        queue.push(target);
      } else packages.add(specifier);
    }
  }
  return { files: [...files].map((file) => relative(SRC, file)), packages: [...packages] };
}

describe('player import graph', () => {
  const graph = importGraph();

  it('reaches the shared renderer and engine (the test is looking at the right graph)', () => {
    expect(graph.files).toContain('features/signage/render/SceneRenderer.tsx');
    expect(graph.files).toContain('features/signage/engine/playback.ts');
  });

  it('uses only React as a package: no Carbon, TanStack Query or React Router', () => {
    expect(graph.packages.filter((name) => !ALLOWED_PACKAGES.has(name))).toEqual([]);
  });

  it('stays out of the application, the generated client and other features', () => {
    const outside = graph.files.filter(
      (file) => !file.startsWith('player/') && !ALLOWED_SHARED.some((pattern) => pattern.test(file)),
    );
    expect(outside).toEqual([]);
  });

  it('loads no Sass', () => {
    expect(graph.files.filter((file) => file.endsWith('.scss'))).toEqual([]);
  });
});
