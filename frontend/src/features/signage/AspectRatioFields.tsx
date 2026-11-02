import { Select, SelectItem, TextInput } from '@carbon/react';
import { useState, type ChangeEvent } from 'react';
import type { FieldErrors, FieldValues, Path, UseFormReturn } from 'react-hook-form';
import type { SignageAspectRatio } from '../../api/generated/models';
import { aspectFieldsOf, CUSTOM, type AspectFields } from './aspectFields';
import { ASPECT_PRESETS, aspectLabel, parseAspectRatio } from './helpers';

const ASPECT_ERROR = 'Enter the ratio as width:height, for example 16:9 (each part from 1 to 100).';

/** A preset `Select` with "Custom…", which reveals a `W:H` input. Works inside any React Hook Form with `AspectFields`. */
export function AspectRatioFields<T extends FieldValues & AspectFields>({
  form,
  idPrefix,
  labelText = 'Aspect ratio',
  helperText,
  disabled = false,
}: {
  form: UseFormReturn<T>;
  idPrefix: string;
  labelText?: string;
  helperText?: string;
  disabled?: boolean;
}) {
  const presetName = 'aspectPreset' as Path<T>;
  const customName = 'aspectCustom' as Path<T>;
  const preset = form.watch(presetName) as string;
  const error = (form.formState.errors as FieldErrors<AspectFields>).aspectCustom;
  const presetField = form.register(presetName);
  return (
    <>
      <Select
        id={`${idPrefix}-aspect`}
        labelText={labelText}
        helperText={helperText}
        disabled={disabled}
        {...presetField}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          void presetField.onChange(event);
          // Custom starts from the ratio that was selected, so it is a small edit rather than a blank field.
          if (event.target.value === CUSTOM && !String(form.getValues(customName) ?? '').trim())
            form.setValue(customName, (preset === CUSTOM ? '' : preset) as never, { shouldDirty: true });
        }}
      >
        {ASPECT_PRESETS.map((item) => (
          <SelectItem key={aspectLabel(item.ratio)} value={aspectLabel(item.ratio)} text={item.label} />
        ))}
        <SelectItem value={CUSTOM} text="Custom…" />
      </Select>
      {preset === CUSTOM && (
        <TextInput
          id={`${idPrefix}-aspect-custom`}
          labelText="Custom ratio (width:height)"
          placeholder="e.g. 16:10"
          autoComplete="off"
          spellCheck={false}
          disabled={disabled}
          invalid={Boolean(error)}
          invalidText={error?.message ?? ASPECT_ERROR}
          {...form.register(customName, {
            validate: (value: unknown) =>
              form.getValues(presetName) !== CUSTOM || parseAspectRatio(String(value)) !== null || ASPECT_ERROR,
          })}
        />
      )}
    </>
  );
}

/** The same preset `Select` plus custom `W:H` input for state that is not in a form (the scene editor autosaves). */
export function AspectRatioSelect({
  value,
  onChange,
  idPrefix,
  labelText = 'Aspect ratio',
}: {
  value: SignageAspectRatio;
  onChange: (ratio: SignageAspectRatio) => void;
  idPrefix: string;
  labelText?: string;
}) {
  const [custom, setCustom] = useState(() => aspectFieldsOf(value).aspectPreset === CUSTOM);
  const [text, setText] = useState(() => aspectLabel(value));
  const invalid = custom && parseAspectRatio(text) === null;
  return (
    <>
      <Select
        id={`${idPrefix}-aspect`}
        labelText={labelText}
        value={custom ? CUSTOM : aspectLabel(value)}
        onChange={(event: ChangeEvent<HTMLSelectElement>) => {
          if (event.target.value === CUSTOM) {
            setCustom(true);
            setText(aspectLabel(value));
            return;
          }
          setCustom(false);
          const preset = ASPECT_PRESETS.find((item) => aspectLabel(item.ratio) === event.target.value);
          if (preset) onChange(preset.ratio);
        }}
      >
        {ASPECT_PRESETS.map((item) => (
          <SelectItem key={aspectLabel(item.ratio)} value={aspectLabel(item.ratio)} text={item.label} />
        ))}
        <SelectItem value={CUSTOM} text="Custom…" />
      </Select>
      {custom && (
        <TextInput
          id={`${idPrefix}-aspect-custom`}
          labelText="Custom ratio (width:height)"
          placeholder="e.g. 16:10"
          autoComplete="off"
          spellCheck={false}
          value={text}
          invalid={invalid}
          invalidText={ASPECT_ERROR}
          onChange={(event) => {
            setText(event.target.value);
            const parsed = parseAspectRatio(event.target.value);
            if (parsed) onChange(parsed);
          }}
        />
      )}
    </>
  );
}
