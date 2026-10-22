import type { ResolvedLayout } from './layouts';

/** Schematic, decorative drawing of a resolved layout (grid or free) for pickers and lists. */
export function LayoutDiagram({
  layout,
  orientation,
  className,
}: {
  layout: ResolvedLayout;
  orientation: 'portrait' | 'landscape';
  className?: string;
}) {
  const classes = `sg-sketch sg-sketch--${orientation}${layout.kind === 'free' ? ' sg-sketch--free' : ''}${className ? ` ${className}` : ''}`;
  if (layout.kind === 'free') {
    return (
      <div className={classes} aria-hidden="true">
        {layout.zones.map((zone, index) => (
          <span
            key={zone.id}
            className="sg-sketch__zone"
            style={{
              insetInlineStart: `${zone.x}%`,
              insetBlockStart: `${zone.y}%`,
              inlineSize: `${zone.width}%`,
              blockSize: `${zone.height}%`,
              zIndex: index + 1,
            }}
          />
        ))}
      </div>
    );
  }
  return (
    <div
      className={classes}
      style={{ gridTemplateColumns: layout.columns, gridTemplateRows: layout.rows }}
      aria-hidden="true"
    >
      {layout.zones.map((zone) => (
        <span
          key={zone.id}
          className="sg-sketch__zone"
          style={{ gridColumn: `${zone.col} / span ${zone.colSpan}`, gridRow: `${zone.row} / span ${zone.rowSpan}` }}
        />
      ))}
    </div>
  );
}
