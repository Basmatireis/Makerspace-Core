import { Stack } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useFormContext } from 'react-hook-form';
import { DecimalField } from '../../../app/DecimalField';
import { decimalValidator } from '../../../app/decimalInput';
import type { MachineProcess } from '../../../api/generated/models';
import { materialTypesQuery } from '../inventoryQueries';
import { materialsForProcess } from '../processConfig';
import { materialsQuery } from '../queries';
import { useCan } from '../shared/useCan';
import type { UsagesValues } from './jobFormHelpers';
import '../styles/jobs.scss';

/** Exact stitch count of an embroidery run; empty means not recorded. */
export function StitchesField({ idPrefix }: { idPrefix: string }) {
  const { control } = useFormContext<UsagesValues>();
  return (
    <Controller
      control={control}
      name="stitches"
      rules={{
        validate: (value) =>
          decimalValidator({ integer: true, optional: true })(value) === true || 'Enter a whole number of stitches.',
      }}
      render={({ field, fieldState }) => (
        <DecimalField
          id={`${idPrefix}-stitches`}
          labelText="Stitches"
          helperText="Exact count from the machine, as a whole number. Priced per 1000 stitches."
          integer
          value={field.value ?? ''}
          invalid={fieldState.invalid}
          invalidText={fieldState.error?.message}
          onChange={field.onChange}
        />
      )}
    />
  );
}

/** One ml field per active ink material (C, M, Y, K, W) of the machine's process; empty means not used. */
export function InkFields({ idPrefix, process }: { idPrefix: string; process: MachineProcess }) {
  const can = useCan();
  const enabled = can('inventory.read');
  const { control } = useFormContext<UsagesValues>();
  const materials = useQuery({ ...materialsQuery({ page: 1, pageSize: 100 }), enabled });
  const types = useQuery({ ...materialTypesQuery(), enabled });
  const inks = materialsForProcess(materials.data?.items ?? [], types.data, process, undefined).filter(
    (material) => material.unit === 'ml',
  );
  if (!enabled) return <p className="mj-secondary">Inventory read access is needed to enter ink consumption.</p>;
  if (materials.isSuccess && types.isSuccess && inks.length === 0)
    return (
      <p className="mj-secondary">No active ink materials for this process. Add UV ink materials in the inventory.</p>
    );
  return (
    <Stack gap={4}>
      <div>
        <h3 className="mj-section-title">Ink</h3>
        <p className="mj-secondary">
          Millilitres per ink as reported by the printer software, with two decimals. Leave empty for inks that were not
          used.
        </p>
      </div>
      <div className="mj-ink-grid">
        {inks.map((material) => (
          <Controller
            key={material.id}
            control={control}
            name={`ink.${material.id}`}
            rules={{ validate: decimalValidator({ optional: true, places: 2 }) }}
            render={({ field, fieldState }) => (
              <DecimalField
                id={`${idPrefix}-ink-${material.id}`}
                invalid={fieldState.invalid}
                invalidText={fieldState.error?.message}
                labelText={
                  <span className="mj-ink-label">
                    {material.colorHex && (
                      <span className="mj-swatch" style={{ backgroundColor: material.colorHex }} aria-hidden="true" />
                    )}
                    {material.colorName ?? material.name} (ml)
                  </span>
                }
                value={field.value ?? ''}
                onChange={field.onChange}
              />
            )}
          />
        ))}
      </div>
    </Stack>
  );
}
