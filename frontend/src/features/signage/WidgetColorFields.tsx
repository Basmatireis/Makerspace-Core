import type { SignageWidget } from '../../api/generated/models';
import { ColorRow } from './editor/BlockStyleFields';
import { widgetColorSpecs } from './widgetColors';
import { withField } from './widgets';

/** The colours of the selected widget; "Reset" goes back to the default look. */
export function WidgetColorFields({
  widget,
  onChange,
}: {
  widget: SignageWidget;
  onChange: (widget: SignageWidget) => void;
}) {
  const specs = widgetColorSpecs(widget.type);
  if (!specs) return null;
  const values = widget as unknown as Record<string, string | undefined>;
  return (
    <fieldset className="sg-fieldset">
      <legend className="cds--label">Colours</legend>
      {specs.map((spec) => (
        <ColorRow
          key={spec.key}
          id={`wf-color-${spec.key}`}
          label={spec.label}
          value={values[spec.key] ?? null}
          clearLabel="Reset"
          emptyText={spec.emptyText}
          fallback={spec.fallback}
          allowTransparent
          onChange={(color) => onChange(withField(widget, spec.key, color ?? undefined))}
        />
      ))}
    </fieldset>
  );
}
