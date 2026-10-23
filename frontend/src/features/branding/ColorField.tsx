import { TextInput } from '@carbon/react';
import { useForm } from 'react-hook-form';
import type { BrandingColors } from '../../api/generated/models';
import { ColorFieldRow, ColorPicker } from '../../app/ColorPicker';
import { FormValues, hexPattern } from './brandingSettings';

export function ColorField({
  name,
  label,
  register,
  setValue,
  value,
  error,
}: {
  name: `colors.${keyof BrandingColors}`;
  label: string;
  register: ReturnType<typeof useForm<FormValues>>['register'];
  setValue: ReturnType<typeof useForm<FormValues>>['setValue'];
  value: string;
  error?: string;
}) {
  const registration = register(name, {
    required: 'Enter a color.',
    pattern: {
      value: hexPattern,
      message: 'Use a six-digit HEX color such as #57569f.',
    },
  });
  return (
    <ColorFieldRow>
      <TextInput
        id={name.replace('.', '-')}
        labelText={label}
        invalid={Boolean(error)}
        invalidText={error}
        {...registration}
        value={value}
      />
      <ColorPicker
        label={`${label} color`}
        value={value}
        onChange={(next) =>
          setValue(name, next, {
            shouldDirty: true,
            shouldTouch: true,
            shouldValidate: true,
          })
        }
      />
    </ColorFieldRow>
  );
}
