import { Controller, useFormContext } from 'react-hook-form';
import type { ProcessMeasure } from '../../../api/generated/models';
import { DecimalField } from '../../../app/DecimalField';
import { decimalValidator } from '../../../app/decimalInput';
import type { UsagesValues } from './jobFormHelpers';
import '../styles/jobs.scss';

/** One whole-number input per counted measure of the machine's process; empty means not recorded. */
export function MeasureFields({ idPrefix, measures }: { idPrefix: string; measures: ProcessMeasure[] }) {
  const { control } = useFormContext<UsagesValues>();
  return (
    <>
      {measures.map((measure) => (
        <Controller
          key={measure.key}
          control={control}
          name={`measures.${measure.key}`}
          rules={{
            validate: (value) =>
              decimalValidator({ integer: true, optional: true })(value ?? '') === true ||
              `Enter a whole number of ${measure.unit}.`,
          }}
          render={({ field, fieldState }) => (
            <DecimalField
              id={`${idPrefix}-measure-${measure.key}`}
              labelText={`${measure.label} (${measure.unit})`}
              helperText={`Exact count from the machine, as a whole number. Priced per ${measure.blockSize} ${measure.unit}.`}
              integer
              value={field.value ?? ''}
              invalid={fieldState.invalid}
              invalidText={fieldState.error?.message}
              onChange={field.onChange}
            />
          )}
        />
      ))}
    </>
  );
}
