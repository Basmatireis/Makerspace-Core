import { TextInput } from '@carbon/react';
import type { ComponentProps } from 'react';

type Props = Omit<ComponentProps<typeof TextInput>, 'value' | 'onChange' | 'type' | 'inputMode'> & {
  value: string;
  onChange: (value: string) => void;
  /** Whole numbers only: numeric keyboard on phones. */
  integer?: boolean;
};

/**
 * Carbon text input for typed numbers. It hands back exactly what was typed; parse it with `parseDecimalText`.
 * A `type="number"` input cannot be used because browsers report "12," as empty, which clears the field.
 */
export function DecimalField({ value, onChange, integer = false, autoComplete = 'off', ...rest }: Props) {
  return (
    <TextInput
      {...rest}
      autoComplete={autoComplete}
      inputMode={integer ? 'numeric' : 'decimal'}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
