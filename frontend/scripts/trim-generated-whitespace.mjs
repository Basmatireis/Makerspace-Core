import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

async function trimDirectory(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await trimDirectory(path);
    } else if (entry.name.endsWith('.ts')) {
      const source = await readFile(path, 'utf8');
      const trimmed = source.replace(/[ \t]+$/gm, '');
      if (trimmed !== source) await writeFile(path, trimmed);
    }
  }
}

await trimDirectory(fileURLToPath(new URL('../src/api/generated', import.meta.url)));
