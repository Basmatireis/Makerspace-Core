import type { DocumentStyles } from '../../model';
import { resolveLength } from '../../styles';
import { SelectField, type Change } from './Inputs';
import { usePanel } from './panelContext';

const textStyleOptions = (styles: DocumentStyles) =>
  styles.text.map((t) => ({ value: t.id, label: `${t.name} · ${resolveLength(t.size, styles)} pt` }));

/** A text style that is named by a part of a block (header text, label text …): "Default" or one of the styles. */
export function PartStyleSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string | undefined;
  onChange: Change<string | undefined>;
}) {
  const { doc } = usePanel();
  return (
    <SelectField
      label={label}
      value={value ?? ''}
      options={[{ value: '', label: 'Default' }, ...textStyleOptions(doc.styles)]}
      onChange={(v, kind) => onChange(v || undefined, kind)}
    />
  );
}

/**
 * The text style of a text-like block: "Custom (set here)" keeps the block's own size, weight and colour, a style
 * replaces them. Choosing Custom again copies the style's values (see `textStyleSwitch`).
 */
export function TextStyleSelect({
  value,
  onChange,
  label = 'Text style',
}: {
  value: string | undefined;
  onChange: Change<string | undefined>;
  label?: string;
}) {
  const { doc } = usePanel();
  return (
    <SelectField
      label={label}
      value={value && doc.styles.text.some((t) => t.id === value) ? value : ''}
      options={[{ value: '', label: 'Custom (set here)' }, ...textStyleOptions(doc.styles)]}
      onChange={(v, kind) => onChange(v || undefined, kind)}
    />
  );
}
