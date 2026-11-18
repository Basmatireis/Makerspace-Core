import { Button, IconButton } from '@carbon/react';
import { Add, TrashCan } from '../icons';
import { useState, type ReactNode } from 'react';
import type { ColorStyle, SizeStyle, TextStyle, TextWeight } from '../model';
import {
  addColor,
  addSize,
  addTextStyle,
  colorToken,
  countTextStyleUsage,
  countUsage,
  removeColor,
  removeSize,
  removeTextStyle,
  resolveColor,
  sizeToken,
  updateColor,
  updateSize,
  updateTextStyle,
} from '../styles';
import type { StylesPanelProps } from '../types';
import { ColorField } from './fields/ColorField';
import { ColorPopover } from './fields/ColorPopover';
import { NumField, SelectField, TextField } from './fields/Inputs';
import { FONT_OPTIONS, WEIGHT_OPTIONS } from './fields/options';
import { PanelProvider } from './fields/PanelProvider';
import { usePanel } from './fields/panelContext';
import { SizeField } from './fields/SizeField';

const usage = (n: number) => (n ? `${n}×` : 'unused');

function Section({
  title,
  description,
  onAdd,
  children,
}: {
  title: string;
  description: string;
  onAdd: () => void;
  children: ReactNode;
}) {
  return (
    <section className="pdft-styles__section" aria-label={title}>
      <div className="pdft-styles__head">
        <div>
          <h2 className="pdft-subhead">{title}</h2>
          <p className="pdft-hint">{description}</p>
        </div>
        <Button kind="ghost" size="sm" renderIcon={Add} onClick={onAdd}>
          Add
        </Button>
      </div>
      {children}
    </section>
  );
}

function DeleteButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <IconButton label={label} kind="ghost" size="sm" align="left" onClick={onClick}>
      <TrashCan />
    </IconButton>
  );
}

function ColorRow({ style }: { style: ColorStyle }) {
  const { doc, edit } = usePanel();
  const [open, setOpen] = useState(false);
  return (
    <div className="pdft-stylerow">
      <ColorPopover
        open={open}
        value={style.value}
        editing={{ id: style.id, name: style.name }}
        onPick={(hex, kind) => edit((d) => updateColor(d, style.id, { value: hex ?? style.value }), kind)}
        onClose={() => setOpen(false)}
        trigger={
          <button
            type="button"
            className="pdft-colorbtn pdft-colorbtn--swatch"
            aria-label={`Edit ${style.name}`}
            aria-haspopup="dialog"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <span className="pdft-swatch" style={{ background: style.value }} />
          </button>
        }
      />
      <TextField
        label="Name"
        value={style.name}
        maxLength={60}
        onChange={(name, kind) => edit((d) => updateColor(d, style.id, { name }), kind)}
      />
      <code className="pdft-mono">{style.value.toUpperCase()}</code>
      <span className="pdft-use">{usage(countUsage(doc, colorToken(style.id)))}</span>
      <DeleteButton
        label={`Delete ${style.name} (uses keep the colour)`}
        onClick={() => edit((d) => removeColor(d, style.id))}
      />
    </div>
  );
}

function TextStyleCard({ style }: { style: TextStyle }) {
  const { doc, edit } = usePanel();
  const patch = (props: Partial<TextStyle>, kind: 'typing' | 'step') =>
    edit((d) => updateTextStyle(d, style.id, props), kind);
  return (
    <div className="pdft-stylecard">
      <div className="pdft-stylerow">
        <span
          className="pdft-agprev"
          aria-hidden
          style={{
            fontWeight: style.weight,
            color: resolveColor(style.color, doc.styles) || undefined,
            fontFamily: style.font === 'Helvetica' ? 'Helvetica, Arial, sans-serif' : "'IBM Plex Sans', sans-serif",
          }}
        >
          Ag
        </span>
        <TextField label="Name" value={style.name} maxLength={60} onChange={(name, kind) => patch({ name }, kind)} />
        <span className="pdft-use">{usage(countTextStyleUsage(doc, style.id))}</span>
        <DeleteButton
          label={`Delete ${style.name} (uses keep its look)`}
          onClick={() => edit((d) => removeTextStyle(d, style.id))}
        />
      </div>
      <div className="pdft-row2">
        <SelectField
          label="Font"
          value={style.font}
          options={FONT_OPTIONS}
          onChange={(font, kind) => patch({ font: font as TextStyle['font'] }, kind)}
        />
        <SizeField
          label="Size (pt)"
          unit="pt"
          step={0.5}
          min={1}
          value={style.size}
          onChange={(v, kind) => patch({ size: v ?? 10 }, kind)}
        />
        <SelectField
          label="Weight"
          value={String(style.weight)}
          options={WEIGHT_OPTIONS}
          onChange={(w, kind) => patch({ weight: Number(w) as TextWeight }, kind)}
        />
        <NumField
          label="Line height"
          value={style.lineHeight}
          step={0.05}
          min={0.8}
          max={3}
          onChange={(v, kind) => patch({ lineHeight: v ?? 1.4 }, kind)}
        />
      </div>
      <ColorField label="Colour" value={style.color} onChange={(v, kind) => patch({ color: v ?? style.color }, kind)} />
    </div>
  );
}

function SizeRow({ style }: { style: SizeStyle }) {
  const { doc, edit } = usePanel();
  const patch = (props: Partial<SizeStyle>, kind: 'typing' | 'step') =>
    edit((d) => updateSize(d, style.id, props), kind);
  return (
    <div className="pdft-stylerow pdft-stylerow--size">
      <TextField label="Name" value={style.name} maxLength={60} onChange={(name, kind) => patch({ name }, kind)} />
      <NumField label="Value" value={style.value} step={0.01} onChange={(v, kind) => patch({ value: v ?? 0 }, kind)} />
      <SelectField
        label="Unit"
        value={style.unit}
        options={[
          { value: 'mm', label: 'mm' },
          { value: 'pt', label: 'pt' },
        ]}
        onChange={(unit, kind) => patch({ unit: unit as SizeStyle['unit'] }, kind)}
      />
      <span className="pdft-use">{usage(countUsage(doc, sizeToken(style.id)))}</span>
      <DeleteButton
        label={`Delete ${style.name} (uses keep the value)`}
        onClick={() => edit((d) => removeSize(d, style.id))}
      />
    </div>
  );
}

function Styles() {
  const { doc, edit } = usePanel();
  const { colors, text, sizes } = doc.styles;
  return (
    <div className="pdft-props">
      <Section
        title="Colours"
        description="Used by text, lines, fills and the accent bar. Change one here and every use follows."
        onAdd={() => edit((d) => addColor(d, '#8a3ffc').doc)}
      >
        {colors.map((c) => (
          <ColorRow key={c.id} style={c} />
        ))}
      </Section>
      <Section
        title="Text styles"
        description="Font, size, weight, line height and colour for headings and text."
        onAdd={() => edit((d) => addTextStyle(d).doc)}
      >
        {text.map((t) => (
          <TextStyleCard key={t.id} style={t} />
        ))}
      </Section>
      <Section
        title="Sizes"
        description="Spacing, widths and line weights that several blocks share."
        onAdd={() => edit((d) => addSize(d).doc)}
      >
        {sizes.map((s) => (
          <SizeRow key={s.id} style={s} />
        ))}
      </Section>
    </div>
  );
}

/** Styles tab of the right pane: colours, text styles and sizes of the document, with how often each is used. */
export function StylesPanel({ doc, schema, onChange }: StylesPanelProps) {
  return (
    <div data-testid="styles-panel" className="pdft-panel">
      <PanelProvider doc={doc} schema={schema} onChange={onChange}>
        <Styles />
      </PanelProvider>
    </div>
  );
}
