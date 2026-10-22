import { useRef } from 'react';
import { Accordion, AccordionItem, MultiSelect, OperationalTag, Select, SelectItem, TextArea } from '@carbon/react';
import type { SignageAsset, SignageRichTextFormat } from '../../api/generated/models';
import { LIMITS, type RichTextWidget, formatOf, withRichText } from './widgets';

const FORMAT_LABELS: Record<SignageRichTextFormat, string> = {
  plain: 'Plain text',
  markdown: 'Markdown',
  html: 'HTML',
};

export function FormatSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: SignageRichTextFormat;
  onChange: (format: SignageRichTextFormat) => void;
}) {
  return (
    <Select
      id={id}
      labelText="Format"
      value={value}
      helperText={
        value === 'plain'
          ? 'Shown as written.'
          : value === 'markdown'
            ? 'Markdown with tables and task lists. Unsafe markup is removed.'
            : 'HTML and <style>. Scripts, forms, frames and unsafe links are removed.'
      }
      onChange={(event) => onChange(event.target.value as SignageRichTextFormat)}
    >
      {(Object.keys(FORMAT_LABELS) as SignageRichTextFormat[]).map((format) => (
        <SelectItem key={format} value={format} text={FORMAT_LABELS[format]} />
      ))}
    </Select>
  );
}

/**
 * A monospace text area (content or CSS) with an optional row of clickable placeholders that insert `{name}` at the
 * cursor. The caret is remembered because the tags take focus.
 */
export function CodeArea({
  id,
  label,
  value,
  maxCount,
  rows = 4,
  helperText,
  placeholders,
  invalidText,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  maxCount: number;
  rows?: number;
  helperText?: string;
  placeholders?: readonly { key: string; label: string }[];
  invalidText?: string;
  onChange: (value: string) => void;
}) {
  const field = useRef<HTMLTextAreaElement | null>(null);
  const caret = useRef<number | null>(null);
  const insert = (key: string) => {
    const at = Math.min(caret.current ?? value.length, value.length);
    const text = `{${key}}`;
    onChange(`${value.slice(0, at)}${text}${value.slice(at)}`);
    caret.current = at + text.length;
    // The new value is rendered first; then the caret moves behind the inserted text.
    window.setTimeout(() => {
      field.current?.focus();
      field.current?.setSelectionRange(at + text.length, at + text.length);
    }, 0);
  };
  return (
    <div className="sg-code-field">
      <TextArea
        id={id}
        ref={field}
        className="sg-code"
        labelText={label}
        rows={rows}
        maxCount={maxCount}
        enableCounter
        spellCheck={false}
        helperText={helperText}
        invalid={Boolean(invalidText)}
        invalidText={invalidText}
        value={value}
        onSelect={(event: React.SyntheticEvent<HTMLTextAreaElement>) => {
          caret.current = event.currentTarget.selectionStart;
        }}
        onChange={(event) => onChange(event.target.value)}
      />
      {placeholders && (
        <div className="sg-placeholder-tags" role="group" aria-label={`Placeholders for ${label}`}>
          {placeholders.map((item) => (
            <OperationalTag
              key={item.key}
              size="sm"
              text={`{${item.key}}`}
              title={item.label}
              onClick={() => insert(item.key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** CSS and fonts of a rich text widget, grouped in a collapsed section because most widgets do not need them. */
export function RichTextAdvanced({
  id,
  widget,
  assets,
  onChange,
}: {
  id: string;
  widget: RichTextWidget;
  assets: readonly SignageAsset[];
  onChange: (widget: RichTextWidget) => void;
}) {
  const fonts = assets.filter((asset) => asset.kind === 'font');
  const selected = fonts.filter((font) => widget.fontAssetIds?.includes(font.id));
  return (
    <Accordion size="md" className="sg-style-accordion">
      <AccordionItem title={widget.css || widget.fontAssetIds?.length ? 'CSS and fonts (in use)' : 'CSS and fonts'}>
        <div className="sg-stack">
          <CodeArea
            id={`${id}-css`}
            label="CSS"
            rows={5}
            maxCount={LIMITS.css}
            value={widget.css ?? ''}
            helperText="Applies inside this zone only. var(--u) is 1 % of the design width."
            onChange={(css) => onChange(withRichText(widget, { css }))}
          />
          <MultiSelect<SignageAsset>
            id={`${id}-fonts`}
            key={fonts.map((font) => font.id).join(',')}
            titleText="Fonts used in CSS"
            label={fonts.length === 0 ? 'No fonts uploaded' : 'Choose fonts'}
            helperText={
              fonts.length === 0
                ? 'Upload WOFF2 fonts under Media.'
                : 'Use the font name in CSS: font-family: "Name". At most 10.'
            }
            items={fonts}
            itemToString={(item) => item?.name ?? ''}
            initialSelectedItems={selected}
            onChange={({ selectedItems }) =>
              onChange(withRichText(widget, { fontAssetIds: (selectedItems ?? []).map((item) => item.id) }))
            }
          />
        </div>
      </AccordionItem>
    </Accordion>
  );
}

/** Format selector and the collapsed CSS and fonts section of a rich text widget. */
export function RichTextOptions({
  id,
  widget,
  assets,
  onChange,
}: {
  id: string;
  widget: RichTextWidget;
  assets: readonly SignageAsset[];
  onChange: (widget: RichTextWidget) => void;
}) {
  return (
    <>
      <FormatSelect
        id={`${id}-format`}
        value={formatOf(widget)}
        onChange={(format) => onChange(withRichText(widget, { format }))}
      />
      <RichTextAdvanced id={id} widget={widget} assets={assets} onChange={onChange} />
    </>
  );
}
