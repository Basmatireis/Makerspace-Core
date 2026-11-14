import { useState, type ReactNode } from 'react';
import {
  AccordionItem,
  Button,
  IconButton,
  NumberInput,
  Select,
  SelectItem,
  Slider,
  TextInput,
  Toggle,
} from '@carbon/react';
import { Opacity } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { SignageBlock, SignageBlockStyle } from '../../../api/generated/models';
import { ColorFieldRow, ColorPicker } from '../../../app/ColorPicker';
import { AssetPicker } from '../components';
import { MediaPicker } from '../MediaPicker';
import { assetsQuery } from '../queries';
import { isMediaWidget } from '../render/style';
import { sharedValue } from './blockOps';

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A hex colour input with the native colour picker beside it; reports only valid, lowercase values (null when emptied). */
export function ColorField({
  id,
  label,
  value,
  nullable = true,
  mixed = false,
  emptyText = 'Not set',
  fallback,
  allowTransparent = false,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string | null;
  nullable?: boolean;
  mixed?: boolean;
  /** Also takes the word "transparent". */
  allowTransparent?: boolean;
  /** Placeholder while no colour is set, e.g. what is used instead. */
  emptyText?: string;
  /** Swatch colour while no colour is set. */
  fallback?: string;
  /** A problem with the colour that is not a typo (e.g. no readable text colour); marks the input invalid. */
  error?: string;
  onChange: (value: string | null) => void;
}) {
  // While typing, the half-finished text is kept here; it is dropped on blur so the field shows the stored value again.
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? value ?? '';
  const valid = HEX.test(text);
  const transparent = allowTransparent && text.toLowerCase() === 'transparent';
  const invalid = typed !== null && !valid && !transparent && !(nullable && typed === '');
  return (
    <ColorFieldRow>
      <TextInput
        id={id}
        labelText={label}
        placeholder={mixed ? 'Mixed' : nullable ? emptyText : '#rrggbb'}
        autoComplete="off"
        value={text}
        invalid={invalid || Boolean(error)}
        invalidText={
          invalid || !error
            ? allowTransparent
              ? 'Enter a hex colour like #161616 or transparent'
              : 'Enter a hex colour like #161616'
            : error
        }
        onChange={(event) => {
          const next = event.target.value.trim();
          setTyped(next);
          if (HEX.test(next) || (allowTransparent && next.toLowerCase() === 'transparent'))
            onChange(next.toLowerCase());
          else if (next === '' && nullable) onChange(null);
        }}
        onBlur={() => setTyped(null)}
      />
      <ColorPicker
        label={label}
        value={valid || (typed === null && value && !transparent) ? text : null}
        fallback={fallback}
        onChange={(next) => {
          setTyped(null);
          onChange(next);
        }}
      />
    </ColorFieldRow>
  );
}

/** A colour field with a button that clears it ("None" for fills, "Reset" for colours that have a fallback), optionally one for transparent. */
export function ColorRow({
  id,
  label,
  value,
  mixed = false,
  clearLabel,
  emptyText,
  fallback,
  allowTransparent = false,
  error,
  onChange,
}: {
  id: string;
  label: string;
  value: string | null;
  mixed?: boolean;
  clearLabel: 'None' | 'Reset';
  emptyText?: string;
  fallback?: string;
  /** Adds a button that makes the colour transparent. */
  allowTransparent?: boolean;
  error?: string;
  onChange: (value: string | null) => void;
}) {
  return (
    <div className="sg-props__color">
      <ColorField
        id={id}
        label={label}
        value={value}
        mixed={mixed}
        emptyText={emptyText}
        fallback={fallback}
        allowTransparent={allowTransparent}
        error={error}
        onChange={onChange}
      />
      {allowTransparent && (
        <IconButton
          label={`${label}: transparent`}
          kind="ghost"
          size="sm"
          align="top-end"
          isSelected={value === 'transparent'}
          onClick={() => onChange('transparent')}
        >
          <Opacity />
        </IconButton>
      )}
      <Button
        kind="ghost"
        size="sm"
        aria-label={`${label}: ${clearLabel}`}
        disabled={value === null && !mixed}
        onClick={() => onChange(null)}
      >
        {clearLabel}
      </Button>
    </div>
  );
}

/** A whole-number field that keeps what is being typed and only reports values within range. */
export function NumField({
  id,
  label,
  value,
  mixed = false,
  min,
  max,
  step = 1,
  helperText,
  hideSteppers = false,
  onChange,
}: {
  id: string;
  label: string;
  value: number | undefined;
  mixed?: boolean;
  min: number;
  max: number;
  step?: number;
  helperText?: string;
  /** Leaves out the − and + buttons, for fields that share a row and would be too narrow for them. */
  hideSteppers?: boolean;
  onChange: (value: number) => void;
}) {
  const [typed, setTyped] = useState<string | null>(null);
  const inRange = (raw: string) =>
    raw.trim() !== '' && Number.isInteger(Number(raw)) && Number(raw) >= min && Number(raw) <= max;
  return (
    <NumberInput
      id={id}
      label={label}
      min={min}
      max={max}
      step={step}
      allowEmpty
      hideSteppers={hideSteppers}
      placeholder={mixed ? 'Mixed' : undefined}
      helperText={helperText}
      value={typed ?? (mixed || value === undefined ? '' : value)}
      invalid={typed !== null && !inRange(typed)}
      invalidText={`Enter a whole number from ${min} to ${max}.`}
      onBlur={() => setTyped(null)}
      onChange={(_, state) => {
        const raw = String(state.value ?? '');
        setTyped(raw);
        if (inRange(raw)) onChange(Number(raw));
      }}
    />
  );
}

/** A percentage slider; Carbon's slider also reports prop changes, so equal values are not passed on. */
export function RangeField({
  id,
  label,
  value,
  mixed = false,
  min = 0,
  max = 100,
  step = 5,
  onChange,
}: {
  id: string;
  label: string;
  value: number | undefined;
  mixed?: boolean;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  return (
    <Slider
      id={id}
      labelText={mixed ? `${label} (Mixed)` : label}
      ariaLabelInput={label}
      min={min}
      max={max}
      step={step}
      formatLabel={(value) => `${value}%`}
      value={value ?? min}
      onChange={({ value: next }) => {
        if (mixed || next !== value) onChange(next);
      }}
    />
  );
}

const MIXED = '__mixed';

/** A select that shows "Mixed" while the selected blocks differ. */
export function PickField<T extends string>({
  id,
  label,
  value,
  mixed = false,
  items,
  onChange,
}: {
  id: string;
  label: string;
  value: T | undefined;
  mixed?: boolean;
  items: readonly { value: T; text: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <Select
      id={id}
      labelText={label}
      value={mixed ? MIXED : (value ?? '')}
      onChange={(event) => onChange(event.target.value as T)}
    >
      {mixed && <SelectItem value={MIXED} text="Mixed" disabled hidden />}
      {items.map((item) => (
        <SelectItem key={item.value} {...item} />
      ))}
    </Select>
  );
}

const FONT_FAMILIES = [
  { value: 'inherit', text: 'As the screen' },
  { value: 'sans', text: 'Sans-serif' },
  { value: 'serif', text: 'Serif' },
  { value: 'mono', text: 'Monospace' },
  { value: 'custom', text: 'Uploaded font' },
] as const;
const WEIGHTS = [
  { value: 'inherit', text: 'As the screen' },
  { value: '400', text: 'Regular' },
  { value: '500', text: 'Medium' },
  { value: '600', text: 'Semibold' },
  { value: '700', text: 'Bold' },
] as const;
const ALIGNS = [
  { value: 'start', text: 'Left' },
  { value: 'center', text: 'Centre' },
  { value: 'end', text: 'Right' },
] as const;
const VERTICAL_ALIGNS = [
  { value: 'start', text: 'Top' },
  { value: 'center', text: 'Middle' },
  { value: 'end', text: 'Bottom' },
] as const;
const BORDER_STYLES = [
  { value: 'solid', text: 'Solid' },
  { value: 'dashed', text: 'Dashed' },
  { value: 'dotted', text: 'Dotted' },
  { value: 'double', text: 'Double' },
] as const;
const SHADOWS = [
  { value: 'none', text: 'None' },
  { value: 'soft', text: 'Soft' },
  { value: 'strong', text: 'Strong' },
  { value: 'glow', text: 'Glow' },
] as const;

/** Widgets that show no text of their own, so the Text section is left out. */
const NO_TEXT = ['empty', 'image', 'video', 'slideshow'];

/** Edits the style of the selected blocks; `key` names the field so typing in it coalesces into one undo step. */
export type StyleChange = (partial: Partial<SignageBlockStyle>, key?: string) => void;

/**
 * The style sections of the properties panel (Text, Fill, Border and shadow, Block) for one or several blocks. Fields whose
 * value differs between the selected blocks show "Mixed". Rendered inside the panel's accordion.
 */
export function BlockStyleFields({
  blocks,
  canEdit,
  onStyle,
  textExtra,
  blockExtra,
  layout,
}: {
  blocks: readonly SignageBlock[];
  canEdit: boolean;
  onStyle: StyleChange;
  /** Shown beside Uppercase at the end of the Text section (the text widget's "shrink to fit"). */
  textExtra?: ReactNode;
  /** Shown at the end of the Block section. */
  blockExtra?: ReactNode;
  /** A section placed between Text and Fill (the single block's position and size). */
  layout?: ReactNode;
}) {
  const ids = blocks.map((b) => b.id);
  const single = blocks.length === 1;
  const hasMedia = blocks.some((b) => isMediaWidget(b.widget.type));
  const showText = !blocks.every((b) => NO_TEXT.includes(b.widget.type));
  const fonts = (useQuery(assetsQuery()).data?.items ?? []).filter((asset) => asset.kind === 'font');
  const get = <K extends keyof SignageBlockStyle>(k: K) => sharedValue(blocks, ids, (b) => b.style[k]);
  const num = (
    k: 'textSize' | 'letterSpacing' | 'lineHeight' | 'borderWidth' | 'radius' | 'padding',
    label: string,
    min: number,
    max: number,
    { step = 1, inRow = false }: { step?: number; inRow?: boolean } = {},
  ) => {
    const v = get(k);
    return (
      <NumField
        id={`bs-${k}`}
        label={label}
        value={v.value}
        mixed={v.mixed}
        min={min}
        max={max}
        step={step}
        hideSteppers={inRow}
        onChange={(next) => onStyle({ [k]: next }, `style.${k}`)}
      />
    );
  };
  const range = (
    k: 'backgroundOpacity' | 'backgroundDim' | 'opacity',
    label: string,
    min: number,
    max: number,
    step = 5,
  ) => {
    const v = get(k);
    return (
      <RangeField
        id={`bs-${k}`}
        label={label}
        value={v.value}
        mixed={v.mixed}
        min={min}
        max={max}
        step={step}
        onChange={(next) => onStyle({ [k]: next }, `style.${k}`)}
      />
    );
  };
  const color = (k: 'backgroundColor' | 'textColor' | 'borderColor', label: string, clearLabel: 'None' | 'Reset') => {
    const v = get(k);
    return (
      <ColorRow
        id={`bs-${k}`}
        label={label}
        value={v.value ?? null}
        mixed={v.mixed}
        clearLabel={clearLabel}
        onChange={(next) => onStyle({ [k]: next }, `style.${k}`)}
      />
    );
  };
  const pick = <K extends 'borderStyle' | 'shadow' | 'fontWeight' | 'align' | 'verticalAlign'>(
    k: K,
    label: string,
    items: readonly { value: SignageBlockStyle[K]; text: string }[],
  ) => {
    const v = get(k);
    return (
      <PickField
        id={`bs-${k}`}
        label={label}
        value={v.value}
        mixed={v.mixed}
        items={items}
        onChange={(next) => onStyle({ [k]: next })}
      />
    );
  };
  const family = get('fontFamily');
  const fontAsset = get('fontAssetId');
  const bgAsset = get('backgroundAssetId');

  const text = showText && (
    <AccordionItem title="Text" open>
      <fieldset className="sg-props__section sg-props__fields" disabled={!canEdit}>
        <div className="sg-props__pair">
          {num('textSize', 'Text size', 8, 400, { inRow: true })}
          {pick('fontWeight', 'Weight', WEIGHTS)}
        </div>
        <PickField
          id="bs-fontFamily"
          label="Font"
          value={family.value}
          mixed={family.mixed}
          items={FONT_FAMILIES}
          onChange={(next) =>
            onStyle({ fontFamily: next, fontAssetId: next === 'custom' ? (fontAsset.value ?? null) : null })
          }
        />
        {family.value === 'custom' && (
          <AssetPicker
            id="bs-fontAssetId"
            label="Uploaded font"
            kind="font"
            assets={fonts}
            value={fontAsset.value ?? null}
            disabledHint={fonts.length === 0 ? 'Upload a WOFF2 font under Media first.' : undefined}
            onChange={(assetId) => onStyle({ fontAssetId: assetId })}
          />
        )}
        {color('textColor', 'Text colour', 'Reset')}
        <div className="sg-props__pair">
          {num('lineHeight', 'Line height (%)', 80, 250, { step: 5, inRow: true })}
          {num('letterSpacing', 'Letter spacing', -10, 50, { inRow: true })}
        </div>
        <div className="sg-props__pair">
          {pick('align', 'Horizontal align', ALIGNS)}
          {pick('verticalAlign', 'Vertical align', VERTICAL_ALIGNS)}
        </div>
        <div className="sg-props__toggles">
          <Toggle
            id="bs-uppercase"
            size="sm"
            labelText="Uppercase"
            labelA="Off"
            labelB="On"
            toggled={get('uppercase').value === true}
            onToggle={(uppercase) => onStyle({ uppercase })}
          />
          {textExtra}
        </div>
      </fieldset>
    </AccordionItem>
  );

  return (
    <>
      {text}
      {layout}
      <AccordionItem title="Fill">
        <fieldset className="sg-props__section sg-props__fields" disabled={!canEdit}>
          {color('backgroundColor', 'Background colour', 'None')}
          {range('backgroundOpacity', 'Background opacity', 0, 100)}
          {single && !hasMedia && (
            <>
              <MediaPicker
                id="bs-backgroundAssetId"
                labelText="Background image"
                kind="image"
                allowNone
                value={bgAsset.value ?? null}
                onChange={(assetId) =>
                  onStyle(assetId ? { backgroundAssetId: assetId } : { backgroundAssetId: null, backgroundDim: 0 })
                }
              />
              {bgAsset.value && range('backgroundDim', 'Darken image', 0, 90)}
            </>
          )}
        </fieldset>
      </AccordionItem>
      <AccordionItem title="Border and shadow">
        <fieldset className="sg-props__section sg-props__fields" disabled={!canEdit}>
          <div className="sg-props__pair">
            {num('borderWidth', 'Border width', 0, 40, { inRow: true })}
            {pick('borderStyle', 'Border style', BORDER_STYLES)}
          </div>
          {color('borderColor', 'Border colour', 'Reset')}
          <div className="sg-props__pair">
            {num('radius', 'Corner radius', 0, 400, { inRow: true })}
            {pick('shadow', 'Shadow', SHADOWS)}
          </div>
        </fieldset>
      </AccordionItem>
      <AccordionItem title="Block">
        <fieldset className="sg-props__section sg-props__fields" disabled={!canEdit}>
          {num('padding', 'Padding', 0, 400)}
          {range('opacity', 'Block opacity', 10, 100)}
          {blockExtra}
        </fieldset>
      </AccordionItem>
    </>
  );
}
