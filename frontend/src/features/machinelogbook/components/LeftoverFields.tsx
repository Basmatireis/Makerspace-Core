/* eslint-disable react-refresh/only-export-components -- the fields and their value helpers belong together */
import { InlineNotification, RadioButton, RadioButtonGroup, Stack } from '@carbon/react';
import { Controller, useFormContext, useWatch } from 'react-hook-form';
import { DecimalField } from '../../../app/DecimalField';
import { decimalNumber, decimalText, decimalValidator } from '../../../app/decimalInput';
import { updateFilamentSpool } from '../../../api/generated/filament-spools/filament-spools';
import type { FilamentLeftoverInput, FilamentSpool } from '../../../api/generated/models';
import type { LeftoverBasis, LeftoverChoice } from '../fillPlan';
import { spoolUpdateBody } from '../spoolData';
import { formatGrams, toDecimal } from './inventoryShared';
import { remainingOf, toNumber } from './spoolShared';

/** Form values shared by every dialog that closes a fill. */
export type LeftoverValues = {
  leftoverBasis: LeftoverBasis;
  /** Typed text; see decimalInput. */
  grossWeight: string;
  tareWeight: string;
  leftoverOutcome: LeftoverChoice['outcome'];
};

type LeftoverSpool = Pick<FilamentSpool, 'remainingQuantity' | 'tareWeightG' | 'materialName'>;

export const leftoverDefaults = (spool: LeftoverSpool | undefined): LeftoverValues => ({
  leftoverBasis: spool && remainingOf(spool) > 0 ? 'system' : 'none',
  grossWeight: '',
  tareWeight: spool?.tareWeightG != null ? decimalText(spool.tareWeightG) : '',
  leftoverOutcome: 'returned_to_stock',
});

/** Turns the form values into the leftover that is previewed; `complete` is false while a weighed value is incomplete. */
export function resolveLeftover(
  spool: LeftoverSpool,
  values: LeftoverValues,
): { choice: LeftoverChoice; complete: boolean } {
  const outcome = values.leftoverOutcome;
  if (values.leftoverBasis === 'none') return { choice: { basis: 'none', leftoverG: 0, outcome }, complete: true };
  if (values.leftoverBasis === 'system')
    return { choice: { basis: 'system', leftoverG: remainingOf(spool), outcome }, complete: true };
  const gross = decimalNumber(values.grossWeight);
  const tare = decimalNumber(values.tareWeight);
  const complete = gross != null && tare != null && gross >= tare;
  return {
    choice: { basis: 'weighed', leftoverG: complete ? Math.round((gross - tare) * 100) / 100 : 0, outcome },
    complete,
  };
}

/** The leftover as the API takes it; a disposition is sent whenever something is left. */
export function toLeftoverInput(spool: LeftoverSpool, values: LeftoverValues): FilamentLeftoverInput {
  const { choice } = resolveLeftover(spool, values);
  const disposition = choice.leftoverG > 0 ? choice.outcome : null;
  if (choice.basis === 'weighed')
    return { basis: 'weighed', grossWeightG: toDecimal(decimalNumber(values.grossWeight) ?? 0), disposition };
  return { basis: choice.basis, disposition };
}

/**
 * Weighing subtracts the spool's recorded tare weight on the backend. When the typed empty weight differs from the
 * record (or none is recorded), it is saved to the spool first. Resolves to the spool version to send with the next request.
 */
export async function saveTareWeight(spool: FilamentSpool, values: LeftoverValues): Promise<number> {
  const tare = decimalNumber(values.tareWeight);
  if (values.leftoverBasis !== 'weighed' || tare === null) return spool.version;
  if (spool.tareWeightG != null && toNumber(spool.tareWeightG) === tare) return spool.version;
  const updated = await updateFilamentSpool(spool.id, spoolUpdateBody(spool, { tareWeightG: toDecimal(tare) }));
  return updated.version;
}

const signed = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${formatGrams(Math.abs(value))}`;

/** Describes the leftover and what is booked for it, in one sentence. */
export function leftoverSummary(spool: LeftoverSpool, choice: LeftoverChoice) {
  const difference = Math.round((choice.leftoverG - remainingOf(spool)) * 100) / 100;
  const base = `Leftover ${formatGrams(choice.leftoverG)} (system expected ${formatGrams(remainingOf(spool))}`;
  return difference === 0
    ? `${base}, no difference).`
    : `${base}, difference ${signed(difference)} recorded as correction).`;
}

/** Leftover questions: how much is left, and what happens to it. Needs a surrounding FormProvider with `LeftoverValues`. */
export function LeftoverFields({ spool, idPrefix }: { spool: LeftoverSpool; idPrefix: string }) {
  const { control } = useFormContext<LeftoverValues>();
  const values = useWatch({ control });
  const resolved = resolveLeftover(spool, values as LeftoverValues);
  const leftover = resolved.choice.leftoverG;
  const basis = values.leftoverBasis;
  const material = spool.materialName || 'the material';
  const remaining = remainingOf(spool);

  const basisHelper =
    basis === 'system'
      ? `The system value of ${formatGrams(remaining)} is taken as is. No correction is recorded.`
      : basis === 'weighed'
        ? 'The weight of the spool minus its empty weight is the leftover. A difference to the system value is recorded as a correction.'
        : remaining > 0
          ? `The expected ${formatGrams(remaining)} is written off with a correction to 0 g. Nothing is moved or discarded.`
          : 'Nothing is recorded; the system already shows 0 g.';

  return (
    <Stack gap={6}>
      <Controller
        control={control}
        name="leftoverBasis"
        render={({ field }) => (
          <RadioButtonGroup
            legendText="How much filament is left on the spool?"
            name={`${idPrefix}-basis`}
            orientation="vertical"
            valueSelected={field.value}
            helperText={basisHelper}
            onChange={(value) => field.onChange(value)}
          >
            <RadioButton
              id={`${idPrefix}-basis-system`}
              value="system"
              labelText={`Use the system value (${formatGrams(remaining)})`}
              disabled={remaining <= 0}
            />
            <RadioButton id={`${idPrefix}-basis-weighed`} value="weighed" labelText="Weigh the spool" />
            <RadioButton id={`${idPrefix}-basis-none`} value="none" labelText="Nothing left, used up" />
          </RadioButtonGroup>
        )}
      />
      {basis === 'weighed' && (
        <>
          <Controller
            control={control}
            name="grossWeight"
            rules={{
              validate: (value, form) => {
                const valid = decimalValidator({ requiredMessage: 'Enter the weight of the spool.' })(value);
                return valid !== true
                  ? valid
                  : (decimalNumber(value) ?? 0) < (decimalNumber(form.tareWeight) ?? 0)
                    ? 'The spool cannot weigh less than its empty weight.'
                    : true;
              },
            }}
            render={({ field, fieldState }) => (
              <DecimalField
                id={`${idPrefix}-gross`}
                labelText="Weight of the spool with filament (g)"
                helperText="Place the whole spool on the scale."
                value={field.value}
                invalid={fieldState.invalid}
                invalidText={fieldState.error?.message}
                onChange={field.onChange}
              />
            )}
          />
          <Controller
            control={control}
            name="tareWeight"
            rules={{ validate: decimalValidator({ requiredMessage: 'Enter the empty weight of the spool.' }) }}
            render={({ field, fieldState }) => (
              <DecimalField
                id={`${idPrefix}-tare`}
                labelText="Empty spool weight (g)"
                helperText={
                  spool.tareWeightG != null
                    ? 'From the spool record; subtracted from the weighed value. A different value updates the record.'
                    : 'Not recorded for this spool; saved to the spool record and subtracted from the weighed value.'
                }
                value={field.value}
                invalid={fieldState.invalid}
                invalidText={fieldState.error?.message}
                onChange={field.onChange}
              />
            )}
          />
          {resolved.complete && (
            <InlineNotification
              kind="info"
              lowContrast
              hideCloseButton
              title="Weighed"
              subtitle={leftoverSummary(spool, resolved.choice)}
            />
          )}
        </>
      )}
      {leftover > 0 && (
        <Controller
          control={control}
          name="leftoverOutcome"
          render={({ field }) => (
            <RadioButtonGroup
              legendText={`What happens to the remaining ${formatGrams(leftover)}?`}
              name={`${idPrefix}-outcome`}
              orientation="vertical"
              valueSelected={field.value}
              helperText={
                field.value === 'returned_to_stock'
                  ? `Moves ${formatGrams(leftover)} from the spool to loose stock of ${material}. The material total stays the same.`
                  : `Writes off ${formatGrams(leftover)} as a disposal. The material total goes down.`
              }
              onChange={(value) => field.onChange(value)}
            >
              <RadioButton
                id={`${idPrefix}-outcome-return`}
                value="returned_to_stock"
                labelText="Return to loose stock"
              />
              <RadioButton id={`${idPrefix}-outcome-dispose`} value="disposed" labelText="Dispose" />
            </RadioButtonGroup>
          )}
        />
      )}
    </Stack>
  );
}
