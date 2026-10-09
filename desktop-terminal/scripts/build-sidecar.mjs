import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = resolve(project, '..');
const target = execFileSync('rustc', ['--print', 'host-tuple'], { encoding: 'utf8' }).trim();
if (!/^[A-Za-z0-9_.-]+$/.test(target)) throw new Error('Rust returned an invalid host target');
const extension = process.platform === 'win32' ? '.exe' : '';
const outputDirectory = resolve(project, 'src-tauri', 'binaries');
mkdirSync(outputDirectory, { recursive: true });
execFileSync('go', [
  'build', '-trimpath', '-tags', 'pcsc',
  '-o', resolve(outputDirectory, `device-bridge-${target}${extension}`),
  './cmd/device-bridge',
], { cwd: resolve(repository, 'backend'), stdio: 'inherit' });
