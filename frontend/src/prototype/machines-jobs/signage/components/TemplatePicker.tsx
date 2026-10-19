import { RadioTile, TileGroup } from '@carbon/react';
import { templates } from '../templates';
import type { Orientation } from '../types';

/** Schematic drawing of a template's zones. */
export function TemplateSketch({ templateId, orientation }: { templateId: string; orientation: Orientation }) {
  const template = templates.find((item) => item.id === templateId) ?? templates[0];
  return (
    <div className={`sg-sketch sg-sketch--${orientation}`} style={{ gridTemplateColumns: template.columns, gridTemplateRows: template.rows }} aria-hidden="true">
      {template.zones.map((zone) => <span key={zone.id} className="sg-sketch__zone" style={{ gridColumn: `${zone.col} / span ${zone.colSpan}`, gridRow: `${zone.row} / span ${zone.rowSpan}` }} />)}
    </div>
  );
}

export function TemplatePicker({ value, orientation, onChange, legend = 'Template' }: { value: string; orientation: Orientation; onChange: (id: string) => void; legend?: string }) {
  return (
    <TileGroup legend={legend} name="scene-template" valueSelected={value} onChange={(next) => onChange(String(next))} className="sg-template-picker">
      {templates.map((template) => (
        <RadioTile key={template.id} id={`template-${template.id}`} value={template.id} className="sg-template-tile">
          <TemplateSketch templateId={template.id} orientation={orientation} />
          <span className="sg-template-tile__name">{template.name}</span>
          <span className="mj-secondary">{template.zones.length} {template.zones.length === 1 ? 'zone' : 'zones'}</span>
        </RadioTile>
      ))}
    </TileGroup>
  );
}
