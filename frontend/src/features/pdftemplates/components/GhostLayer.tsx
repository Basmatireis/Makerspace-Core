import { useEffect, useRef } from 'react';
import { GHOST_PAD_MM, ghostLayout, type Rect } from '../ghost';
import type { Ghost } from '../useGhost';

/** The cover over the original place and the copy at the new one, inside one page. */
export function GhostLayer({ ghost, at, k }: { ghost: Ghost; at: Rect; k: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const target = canvas.current;
    if (!target || !ghost.snap) return;
    target.width = ghost.snap.width;
    target.height = ghost.snap.height;
    target.getContext('2d')?.drawImage(ghost.snap, 0, 0);
  }, [ghost.snap]);

  const cover = {
    left: (ghost.from.x - GHOST_PAD_MM) * k,
    top: (ghost.from.y - GHOST_PAD_MM) * k,
    width: (ghost.from.w + 2 * GHOST_PAD_MM) * k,
    height: (ghost.from.h + 2 * GHOST_PAD_MM) * k,
  };
  const layout = ghost.area ? ghostLayout(ghost.from, at, ghost.area, k, ghost.stretch) : null;
  return (
    <>
      <div className="pdft-ghost__cover" style={cover} data-testid="ghost-cover" />
      {layout && (
        <div className="pdft-ghost" style={layout.window} data-testid="ghost">
          <canvas ref={canvas} className="pdft-ghost__picture" style={layout.picture} aria-hidden="true" />
        </div>
      )}
    </>
  );
}
