import { describe, expect, it } from 'vitest';
import { playerShellFiles } from './shellFiles';

// The service worker precaches the player's static files, the fonts of its CSS and its lazy chunks (the rich text
// renderer), so a display that starts offline can still render markdown and HTML in IBM Plex.

describe('player shell files', () => {
  const manifest = {
    'player.html': {
      file: 'assets/player-1.js',
      imports: ['_react.js'],
      dynamicImports: ['src/features/signage/render/richText.ts'],
      css: ['assets/player-1.css'],
      assets: ['assets/IBMPlexSans-Regular-Latin1-7.woff2'],
    },
    '_react.js': { file: 'assets/react-2.js' },
    'src/features/signage/render/richText.ts': {
      file: 'assets/richText-3.js',
      imports: ['_purify.js'],
      css: ['assets/richText-3.css'],
    },
    '_purify.js': { file: 'assets/purify-4.js' },
    'index.html': { file: 'assets/main-5.js', imports: ['_react.js', '_admin.js'] },
    '_admin.js': { file: 'assets/admin-6.js' },
  };

  it('lists static imports, CSS with its fonts and the lazy chunk with its own imports, sorted', () => {
    expect(playerShellFiles(manifest)).toEqual([
      '/assets/IBMPlexSans-Regular-Latin1-7.woff2',
      '/assets/player-1.css',
      '/assets/player-1.js',
      '/assets/purify-4.js',
      '/assets/react-2.js',
      '/assets/richText-3.css',
      '/assets/richText-3.js',
    ]);
  });

  it('leaves out the application', () => {
    expect(playerShellFiles(manifest).join()).not.toMatch(/main-5|admin-6/);
  });
});
