import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'generated' ? [] : sources(path);
    return /\.tsx$/.test(name) && !/\.test\.tsx$/.test(name) ? [path] : [];
  });

/**
 * Carbon's ActionableNotification defaults to role="alertdialog", which focuses its action button after every render
 * and traps focus inside the notification. A page that re-renders on a timer then scrolls to the notification every
 * few seconds and swallows clicks elsewhere (the Printer setup "Needs attention" banner did exactly that). Inline
 * notifications in this app are passive, so every one of them must say role="status".
 */
describe('ActionableNotification usage', () => {
  it('always sets an explicit role', () => {
    const offenders: string[] = [];
    for (const path of sources(join(__dirname, '..'))) {
      const code = readFileSync(path, 'utf8');
      for (const match of code.matchAll(/<ActionableNotification\b([^>]*?)(\/>|>)/gs)) {
        if (!/\brole=/.test(match[1])) {
          const line = code.slice(0, match.index).split('\n').length;
          offenders.push(`${path}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
