import { useState } from 'react';
import { Accordion, AccordionItem, Button, NumberInput, Select, SelectItem, TextInput } from '@carbon/react';
import type { SignageAsset, SignageStyleAlign, SignageWidgetStyle } from '../../api/generated/models';
import { AssetPicker } from './components';
import { clampInt, defaultStyle } from './widgets';

/**
 * A hex colour input with a swatch. Carbon has no colour picker, so the value is typed as `#rrggbb`; the widget only
 * receives valid, lowercase values (or null when emptied and `nullable`).
 */
export function ColorField({
  id,
  label,
  value,
  nullable = true,
  onChange,
}: {
  id: string;
  label: string;
  value: string | null;
  nullable?: boolean;
  onChange: (value: string | null) => void;
}) {
  // While typing, the half-finished text is kept here; it is dropped on blur so the field shows the stored value again.
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? value ?? '';
  const valid = /^#[0-9a-fA-F]{6}$/.test(text);
  const invalid = typed !== null && !valid && !(nullable && typed === '');
  return (
    <div className="sg-colour-field">
      <TextInput
        id={id}
        labelText={label}
        placeholder={nullable ? 'Not set' : '#rrggbb'}
        autoComplete="off"
        value={text}
        invalid={invalid}
        invalidText="Enter a hex colour like #161616"
        onChange={(event) => {
          const next = event.target.value.trim();
          setTyped(next);
          if (/^#[0-9a-fA-F]{6}$/.test(next)) onChange(next.toLowerCase());
          else if (next === '' && nullable) onChange(null);
        }}
        onBlur={() => setTyped(null)}
      />
      <span
        className="sg-colour-field__swatch"
        style={{ background: valid || (typed === null && value) ? text : 'transparent' }}
        aria-hidden="true"
      />
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  min,
  max,
  step = 1,
  helperText,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  helperText?: string;
  onChange: (value: number) => void;
}) {
  return (
    <NumberInput
      id={id}
      label={label}
      min={min}
      max={max}
      step={step}
      value={value}
      helperText={helperText}
      onChange={(_, { value: next }) => {
        const number = clampInt(next, min, max);
        if (number !== null) onChange(number);
      }}
    />
  );
}

const ALIGN_ITEMS: { value: SignageStyleAlign; text: string }[] = [
  { value: 'inherit', text: 'As the widget' },
  { value: 'start', text: 'Start' },
  { value: 'center', text: 'Centre' },
  { value: 'end', text: 'End' },
];

type Props = {
  /** Prefix that keeps ids unique when several panels exist (the announcement box style, for example). */
  id?: string;
  style: SignageWidgetStyle | undefined;
  assets: readonly SignageAsset[];
  onChange: (style: SignageWidgetStyle | undefined) => void;
};

/**
 * The common style of a zone box: colours, spacing, font and alignment. Collapsed by default; "Reset style" removes the
 * style so the widget looks as before. Every change is applied immediately like the other widget fields.
 */
export function WidgetStyleFields({ id = 'wf-style', style, assets, onChange }: Props) {
  // Remounts the colour inputs after a reset so they drop what was typed.
  const [generation, setGeneration] = useState(0);
  const current = style ?? defaultStyle();
  const patch = (change: Partial<SignageWidgetStyle>) => onChange({ ...current, ...change });
  const fonts = assets.filter((asset) => asset.kind === 'font');
  return (
    <Accordion size="md" className="sg-style-accordion">
      <AccordionItem title={style ? 'Style (customised)' : 'Style'}>
        <div className="sg-stack" key={generation}>
          <div className="sg-form-row">
            <ColorField
              id={`${id}-text`}
              label="Zone text colour"
              value={current.textColor}
              onChange={(textColor) => patch({ textColor })}
            />
            <ColorField
              id={`${id}-background`}
              label="Zone background colour"
              value={current.backgroundColor}
              onChange={(backgroundColor) => patch({ backgroundColor })}
            />
          </div>
          <div className="sg-form-row">
            <NumberField
              id={`${id}-opacity`}
              label="Background opacity (%)"
              min={0}
              max={100}
              step={10}
              value={current.backgroundOpacity}
              onChange={(backgroundOpacity) => patch({ backgroundOpacity })}
            />
            <ColorField
              id={`${id}-border`}
              label="Zone border colour"
              value={current.borderColor}
              onChange={(borderColor) => patch({ borderColor })}
            />
          </div>
          <div className="sg-form-row">
            <NumberField
              id={`${id}-border-width`}
              label="Border width"
              helperText="Tenths of u, 0 to 20"
              min={0}
              max={20}
              value={current.borderWidth}
              onChange={(borderWidth) => patch({ borderWidth })}
            />
            <NumberField
              id={`${id}-radius`}
              label="Corner radius"
              helperText="u, 0 to 10"
              min={0}
              max={10}
              value={current.radius}
              onChange={(radius) => patch({ radius })}
            />
          </div>
          <div className="sg-form-row">
            <NumberField
              id={`${id}-padding`}
              label="Padding"
              helperText="u, 0 to 10"
              min={0}
              max={10}
              value={current.padding}
              onChange={(padding) => patch({ padding })}
            />
            <NumberField
              id={`${id}-scale`}
              label="Font size (%)"
              helperText="25 to 400"
              min={25}
              max={400}
              step={5}
              value={current.fontScale}
              onChange={(fontScale) => patch({ fontScale })}
            />
          </div>
          <Select
            id={`${id}-family`}
            labelText="Font family"
            value={current.fontFamily}
            onChange={(event) => {
              const fontFamily = event.target.value as SignageWidgetStyle['fontFamily'];
              patch({ fontFamily, fontAssetId: fontFamily === 'custom' ? current.fontAssetId : null });
            }}
          >
            <SelectItem value="inherit" text="As the scene" />
            <SelectItem value="sans" text="Sans-serif" />
            <SelectItem value="serif" text="Serif" />
            <SelectItem value="mono" text="Monospace" />
            <SelectItem value="custom" text="Uploaded font" />
          </Select>
          {current.fontFamily === 'custom' && (
            <AssetPicker
              id={`${id}-font`}
              label="Font"
              kind="font"
              assets={fonts}
              value={current.fontAssetId}
              disabledHint={fonts.length === 0 ? 'Upload a WOFF2 font under Media first.' : undefined}
              onChange={(fontAssetId) => patch({ fontAssetId })}
            />
          )}
          <div className="sg-form-row">
            <Select
              id={`${id}-align`}
              labelText="Horizontal alignment"
              value={current.align}
              onChange={(event) => patch({ align: event.target.value as SignageStyleAlign })}
            >
              {ALIGN_ITEMS.map((item) => (
                <SelectItem key={item.value} {...item} />
              ))}
            </Select>
            <Select
              id={`${id}-vertical`}
              labelText="Vertical alignment"
              value={current.verticalAlign}
              onChange={(event) => patch({ verticalAlign: event.target.value as SignageStyleAlign })}
            >
              {ALIGN_ITEMS.map((item) => (
                <SelectItem key={item.value} {...item} />
              ))}
            </Select>
          </div>
          <p className="sg-secondary">u is 1 % of the design width, so sizes scale with the screen.</p>
          <div>
            <Button
              kind="ghost"
              size="sm"
              disabled={!style}
              onClick={() => {
                setGeneration((value) => value + 1);
                onChange(undefined);
              }}
            >
              Reset style
            </Button>
          </div>
        </div>
      </AccordionItem>
    </Accordion>
  );
}
