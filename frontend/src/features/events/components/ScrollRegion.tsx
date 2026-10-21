import type { ReactNode } from 'react';

/** A wide table that scrolls sideways on its own; focusable and named so keyboard users can scroll it. */
export function ScrollRegion({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ev-scroll" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
