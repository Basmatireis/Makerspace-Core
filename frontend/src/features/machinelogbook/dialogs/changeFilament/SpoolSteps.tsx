import { Controller } from 'react-hook-form';
import { ComboBox, Stack } from '@carbon/react';
import type { FilamentSpool } from '../../../../api/generated/models';
import { LeftoverFields } from '../../components/LeftoverFields';
import { formatGrams } from '../../components/inventoryShared';
import { initialOf, needsRefill, remainingOf, spoolNameText } from '../../components/spoolShared';
import { formatDateTime } from '../../shared/format';
import { type ChangeFilamentWizard } from './useChangeFilamentWizard';

export function SpoolStep({ wizard }: { wizard: ChangeFilamentWizard }) {
  const { choices, spool, chooseSpool, control } = wizard;

  return (
    <Controller
      control={control}
      name="spoolId"
      rules={{ required: 'Choose a spool.' }}
      render={({ fieldState }) => (
        <ComboBox<FilamentSpool>
          autoAlign
          id="refill-spool"
          titleText="Spool"
          placeholder="Search by ID, label, material or tag"
          items={choices}
          helperText="Reusable spools only. Scan or type a tag value to find a spool."
          itemToString={(item) =>
            item ? `${spoolNameText(item)} · ${needsRefill(item) ? 'Needs refill' : item.materialName}` : ''
          }
          shouldFilterItem={({ item, inputValue }) => {
            const text = (inputValue ?? '').trim().toLowerCase();
            if (!item || !text) return true;
            return [
              item.displayId,
              item.label,
              item.materialName,
              ...item.identifiers.map((identifier) => identifier.value),
            ]
              .filter(Boolean)
              .join(' ')
              .toLowerCase()
              .includes(text);
          }}
          selectedItem={spool ? (choices.find((item) => item.id === spool.id) ?? null) : null}
          onChange={({ selectedItem }) => chooseSpool(selectedItem ?? null)}
          invalid={fieldState.invalid}
          invalidText={fieldState.error?.message}
        />
      )}
    />
  );
}

export function LeftoverStep({ spool }: { spool: FilamentSpool }) {
  return (
    <Stack gap={6}>
      <dl className="mj-facts">
        <div>
          <dt>Current fill</dt>
          <dd>
            {spool.materialName} · fill {spool.fillNumber}
            {spool.filledAt ? ` · since ${formatDateTime(spool.filledAt)}` : ''}
          </dd>
        </div>
        <div>
          <dt>Expected remaining</dt>
          <dd>
            {formatGrams(remainingOf(spool))} of {formatGrams(initialOf(spool))}
          </dd>
        </div>
      </dl>
      <LeftoverFields spool={spool} idPrefix="refill" />
    </Stack>
  );
}
