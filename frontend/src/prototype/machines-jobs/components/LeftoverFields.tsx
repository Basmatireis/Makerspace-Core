/* eslint-disable react-refresh/only-export-components -- the fields and their value helpers belong together */
import { InlineNotification, NumberInput, RadioButton, RadioButtonGroup, Stack } from '@carbon/react';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { formatGrams } from './inventoryShared';
import type { LeftoverBasis, LeftoverChoice } from '../fillPlan';
import type { Spool } from '../types';

/** Form values shared by every dialog that closes a fill. */
export type LeftoverValues = {
  leftoverBasis: LeftoverBasis;
  grossWeight: number | '';
  tareWeight: number | '';
  leftoverOutcome: LeftoverChoice['outcome'];
};

export const leftoverDefaults = (spool: Spool | undefined): LeftoverValues => ({
  leftoverBasis: spool && spool.remainingQuantity > 0 ? 'system' : 'none',
  grossWeight: '', tareWeight: spool?.tareWeightG ?? '', leftoverOutcome: 'returned_to_stock',
});

/** Turns the form values into the leftover the store books; `leftoverG` is null while a weighed value is incomplete. */
export function resolveLeftover(spool: Spool, values: LeftoverValues): { choice: LeftoverChoice; complete: boolean } {
  const outcome = values.leftoverOutcome;
  if (values.leftoverBasis === 'none') return { choice: { basis: 'none', leftoverG: 0, outcome }, complete: true };
  if (values.leftoverBasis === 'system') return { choice: { basis: 'system', leftoverG: spool.remainingQuantity, outcome }, complete: true };
  const gross = values.grossWeight === '' ? null : Number(values.grossWeight);
  const tare = values.tareWeight === '' ? null : Number(values.tareWeight);
  const complete = gross != null && tare != null && gross >= tare;
  return { choice: { basis: 'weighed', leftoverG: complete ? Math.round((gross - tare) * 100) / 100 : 0, outcome }, complete };
}

const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatGrams(Math.abs(value))}`;

/** Describes the leftover and what is booked for it, in one sentence. */
export function leftoverSummary(spool: Spool, choice: LeftoverChoice) {
  const difference = Math.round((choice.leftoverG - spool.remainingQuantity) * 100) / 100;
  const base = `Leftover ${formatGrams(choice.leftoverG)} (system expected ${formatGrams(spool.remainingQuantity)}`;
  return difference === 0 ? `${base}, no difference).` : `${base}, difference ${signed(difference)} recorded as correction).`;
}

/** Leftover questions: how much is left, and what happens to it. Needs a surrounding FormProvider with `LeftoverValues`. */
export function LeftoverFields({ spool, idPrefix }: { spool: Spool; idPrefix: string }) {
  const { control } = useFormContext<LeftoverValues>();
  const values = useWatch({ control });
  const resolved = resolveLeftover(spool, values as LeftoverValues);
  const leftover = resolved.choice.leftoverG;
  const basis = values.leftoverBasis;
  const material = spool.materialName || 'the material';

  const basisHelper = basis === 'system'
    ? `The system value of ${formatGrams(spool.remainingQuantity)} is taken as is. No correction is recorded.`
    : basis === 'weighed'
      ? 'The weight of the spool minus its empty weight is the leftover. A difference to the system value is recorded as a correction.'
      : spool.remainingQuantity > 0 ? `The expected ${formatGrams(spool.remainingQuantity)} is written off with a correction to 0 g. Nothing is moved or discarded.` : 'Nothing is recorded; the system already shows 0 g.';

  return (
    <Stack gap={6}>
      <Controller
        control={control} name="leftoverBasis"
        render={({ field }) => (
          <RadioButtonGroup legendText="How much filament is left on the spool?" name={`${idPrefix}-basis`} orientation="vertical" valueSelected={field.value} helperText={basisHelper} onChange={(value) => field.onChange(value)}>
            <RadioButton id={`${idPrefix}-basis-system`} value="system" labelText={`Use the system value (${formatGrams(spool.remainingQuantity)})`} disabled={spool.remainingQuantity <= 0} />
            <RadioButton id={`${idPrefix}-basis-weighed`} value="weighed" labelText="Weigh the spool" />
            <RadioButton id={`${idPrefix}-basis-none`} value="none" labelText="Nothing left, used up" />
          </RadioButtonGroup>
        )}
      />
      {basis === 'weighed' && (
        <>
          <Controller
            control={control} name="grossWeight"
            rules={{ validate: (value, form) => value === '' ? 'Enter the weight of the spool.' : Number(value) < Number(form.tareWeight || 0) ? 'The spool cannot weigh less than its empty weight.' : true }}
            render={({ field, fieldState }) => (
              <NumberInput
                id={`${idPrefix}-gross`} label="Weight of the spool with filament (g)" helperText="Place the whole spool on the scale." allowEmpty min={0} step={1} hideSteppers
                value={field.value} invalid={fieldState.invalid} invalidText={fieldState.error?.message} onChange={(_event, state) => field.onChange(state.value === '' ? '' : Number(state.value))}
              />
            )}
          />
          <Controller
            control={control} name="tareWeight"
            rules={{ validate: (value) => value === '' ? 'Enter the empty weight of the spool.' : Number(value) < 0 ? 'Enter a weight of zero or more.' : true }}
            render={({ field, fieldState }) => (
              <NumberInput
                id={`${idPrefix}-tare`} label="Empty spool weight (g)" helperText={spool.tareWeightG != null ? 'From the spool record; subtracted from the weighed value.' : 'Not recorded for this spool; subtracted from the weighed value.'}
                allowEmpty min={0} step={1} hideSteppers value={field.value} invalid={fieldState.invalid} invalidText={fieldState.error?.message}
                onChange={(_event, state) => field.onChange(state.value === '' ? '' : Number(state.value))}
              />
            )}
          />
          {resolved.complete && <InlineNotification kind="info" lowContrast hideCloseButton title="Weighed" subtitle={leftoverSummary(spool, resolved.choice)} />}
        </>
      )}
      {leftover > 0 && (
        <Controller
          control={control} name="leftoverOutcome"
          render={({ field }) => (
            <RadioButtonGroup
              legendText={`What happens to the remaining ${formatGrams(leftover)}?`} name={`${idPrefix}-outcome`} orientation="vertical" valueSelected={field.value}
              helperText={field.value === 'returned_to_stock'
                ? `Moves ${formatGrams(leftover)} from the spool to loose stock of ${material}. The material total stays the same.`
                : `Writes off ${formatGrams(leftover)} as a disposal. The material total goes down.`}
              onChange={(value) => field.onChange(value)}
            >
              <RadioButton id={`${idPrefix}-outcome-return`} value="returned_to_stock" labelText="Return to loose stock" />
              <RadioButton id={`${idPrefix}-outcome-dispose`} value="disposed" labelText="Dispose" />
            </RadioButtonGroup>
          )}
        />
      )}
    </Stack>
  );
}
