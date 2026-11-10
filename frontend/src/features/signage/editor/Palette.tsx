import type { DragEvent } from 'react';
import { Button } from '@carbon/react';

import { WIDGET_LABELS, type WidgetType } from '../widgets';
import { PALETTE_MIME, WIDGET_ICONS } from './widgetIcons';

const GROUPS: { label: string; types: WidgetType[] }[] = [
  { label: 'Text and media', types: ['text', 'image', 'video', 'slideshow', 'qr'] },
  { label: 'Live', types: ['clock', 'status', 'camera', 'timelapse'] },
  { label: 'Calendar', types: ['open_days', 'events', 'agenda', 'calendar'] },
  { label: 'Notices', types: ['announcement'] },
];

/** Widget types to add: a click adds one (or fills the selected empty block), dragging drops one onto the canvas. */
export function Palette({
  disabled,
  onAdd,
  onDragType,
}: {
  disabled: boolean;
  onAdd: (type: WidgetType) => void;
  onDragType: (type: WidgetType | null) => void;
}) {
  return (
    <section className="sg-palette" aria-labelledby="sg-palette-title">
      <h2 id="sg-palette-title" className="sg-pane__title">
        Add to screen
      </h2>
      <p className="sg-pane__hint">Click to add, or drag onto the screen or into an empty block.</p>
      {GROUPS.map((group) => (
        <div key={group.label} className="sg-palette__group">
          <h3 className="sg-palette__label">{group.label}</h3>
          <div className="sg-palette__items">
            {group.types.map((type) => (
              <Button
                key={type}
                kind="ghost"
                size="sm"
                className="sg-palette__item"
                disabled={disabled}
                renderIcon={WIDGET_ICONS[type]}
                draggable={!disabled}
                onClick={() => onAdd(type)}
                onDragStart={(event: DragEvent) => {
                  event.dataTransfer.setData(PALETTE_MIME, type);
                  event.dataTransfer.effectAllowed = 'copy';
                  onDragType(type);
                }}
                onDragEnd={() => onDragType(null)}
              >
                {WIDGET_LABELS[type]}
              </Button>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
