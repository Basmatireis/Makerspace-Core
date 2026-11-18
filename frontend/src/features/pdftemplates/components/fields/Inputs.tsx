import { Checkbox, NumberInput, Select, SelectItem, SelectItemGroup, TextArea, TextInput } from '@carbon/react';
import { useEffect, useId, useRef, type FocusEvent, type ReactNode } from 'react';
import type { ChangeKind } from '../../history';
import { useInsertRegistry } from '../../insertTarget';

/**
 * The basic fields of the panels: thin wrappers around Carbon's inputs that report `(value, kind)`. Text and numbers are
 * `typing` edits (one undo step per burst), choices are `step`s.
 */
export type Change<T> = (value: T, kind: ChangeKind) => void;

interface TextFieldProps {
  label: string;
  value: string;
  onChange: Change<string>;
  helper?: ReactNode;
  maxLength?: number;
  onBlur?: () => void;
  placeholder?: string;
}

/** A single-line text that is not an expression (names, titles). */
export function TextField({ label, value, onChange, helper, maxLength, onBlur, placeholder }: TextFieldProps) {
  const id = useId();
  return (
    <TextInput
      id={id}
      size="sm"
      labelText={label}
      value={value}
      helperText={helper}
      maxLength={maxLength}
      placeholder={placeholder}
      onBlur={onBlur}
      onChange={(event) => onChange(event.target.value, 'typing')}
    />
  );
}

/**
 * A text with `{{variable | filter}}` tokens. The field that had focus last receives a variable chosen in the Variables
 * tab (see `insertTarget`).
 */
export function ExprField({
  label,
  value,
  onChange,
  area,
  rows = 3,
  helper,
  maxLength = 4000,
  hideLabel,
}: TextFieldProps & { area?: boolean; rows?: number; hideLabel?: boolean }) {
  const id = useId();
  const registry = useInsertRegistry();
  // The registry calls the latest handler, not the one of the render that was focused.
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  }, [onChange]);
  const remember = (event: FocusEvent<HTMLInputElement | HTMLTextAreaElement>) =>
    registry?.remember({ element: event.currentTarget, set: (text) => latest.current(text, 'step') });
  return area ? (
    <TextArea
      id={id}
      labelText={label}
      hideLabel={hideLabel}
      value={value}
      rows={rows}
      helperText={helper}
      maxLength={maxLength}
      onFocus={remember}
      onChange={(event) => onChange(event.target.value, 'typing')}
    />
  ) : (
    <TextInput
      id={id}
      size="sm"
      labelText={label}
      hideLabel={hideLabel}
      value={value}
      helperText={helper}
      maxLength={maxLength}
      onFocus={remember}
      onChange={(event) => onChange(event.target.value, 'typing')}
    />
  );
}

export function NumField({
  label,
  value,
  onChange,
  step = 0.1,
  min,
  max,
  helper,
  hideLabel,
}: {
  label: string;
  /** Undefined shows an empty field. */
  value: number | undefined;
  /** Undefined when the field was emptied. */
  onChange: Change<number | undefined>;
  step?: number;
  min?: number;
  max?: number;
  helper?: ReactNode;
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <NumberInput
      id={id}
      size="sm"
      label={label}
      hideLabel={hideLabel}
      value={value ?? ''}
      step={step}
      min={min}
      max={max}
      allowEmpty
      hideSteppers
      helperText={helper}
      onChange={(_event, state) => {
        const n = state.value === '' ? NaN : Number(state.value);
        onChange(Number.isFinite(n) ? n : undefined, 'typing');
      }}
    />
  );
}

export type Option = { value: string; label: string };
export type OptionGroup = { group: string; options: Option[] };

export function SelectField({
  label,
  value,
  options,
  onChange,
  helper,
  hideLabel,
}: {
  label: string;
  value: string;
  options: (Option | OptionGroup)[];
  onChange: Change<string>;
  helper?: ReactNode;
  hideLabel?: boolean;
}) {
  const id = useId();
  const item = (o: Option) => <SelectItem key={o.value} value={o.value} text={o.label} />;
  return (
    <Select
      id={id}
      size="sm"
      labelText={label}
      hideLabel={hideLabel}
      helperText={helper}
      value={value}
      onChange={(event) => onChange(event.target.value, 'step')}
    >
      {options.map((o) =>
        'group' in o ? (
          <SelectItemGroup key={o.group} label={o.group}>
            {o.options.map(item)}
          </SelectItemGroup>
        ) : (
          item(o)
        ),
      )}
    </Select>
  );
}

export function CheckField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: Change<boolean>;
}) {
  const id = useId();
  return (
    <Checkbox
      id={id}
      labelText={label}
      checked={checked}
      onChange={(_event, state) => onChange(state.checked, 'step')}
    />
  );
}
