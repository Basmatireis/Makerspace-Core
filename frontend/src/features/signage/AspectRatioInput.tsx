import { IconButton, NumberInput } from '@carbon/react';
import { ArrowsHorizontal } from '@carbon/icons-react';
import { ratioOfParts, ratioPartsError, shapeName, type RatioParts } from './aspectFields';

/** Screen shape as two number fields (width : height) with a swap button and the shape name as a live hint. */
export function AspectRatioInput({
  id,
  labelText = 'Shape of the display (width : height)',
  value,
  onChange,
  disabled = false,
}: {
  id: string;
  labelText?: string;
  value: RatioParts;
  onChange: (parts: RatioParts) => void;
  disabled?: boolean;
}) {
  const error = ratioPartsError(value.width, value.height);
  const hint = error ?? shapeName(ratioOfParts(value));
  const hintId = `${id}-hint`;
  const part = (key: keyof RatioParts, label: string) => (
    <NumberInput
      id={`${id}-${key}`}
      label={label}
      hideLabel
      hideSteppers
      allowEmpty
      min={1}
      max={999}
      step={1}
      disabled={disabled}
      invalid={error !== null}
      invalidText=""
      value={value[key]}
      aria-describedby={hintId}
      onChange={(_, state) => onChange({ ...value, [key]: String(state.value ?? '') })}
    />
  );
  return (
    <fieldset className="sg-ratio" disabled={disabled}>
      <legend className="cds--label">{labelText}</legend>
      <div className="sg-ratio__row">
        {part('width', 'Width part of the ratio')}
        <span aria-hidden="true" className="sg-ratio__colon">
          :
        </span>
        {part('height', 'Height part of the ratio')}
        <IconButton
          label="Swap width and height"
          kind="ghost"
          size="md"
          align="top"
          disabled={disabled}
          onClick={() => onChange({ width: value.height, height: value.width })}
        >
          <ArrowsHorizontal />
        </IconButton>
      </div>
      <p id={hintId} role="status" className={error ? 'sg-ratio__hint sg-ratio__hint--error' : 'sg-ratio__hint'}>
        {hint}
      </p>
    </fieldset>
  );
}
