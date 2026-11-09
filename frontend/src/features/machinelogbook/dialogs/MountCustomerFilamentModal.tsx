import { useState } from 'react';
import { InlineNotification, Modal, Stack, TextInput } from '@carbon/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { PrinterSlot } from '../../../api/generated/models';
import { mountCustomerFilament } from '../../../api/generated/printing/printing';
import { FuzzySelectField } from '../../../app/components/FuzzyComboBox';
import { saveError } from './jobFormHelpers';
import { typesForProcess } from './MaterialPickerModal';
import { materialTypesQuery } from '../inventoryQueries';

/**
 * Records filament the customer brought as loaded in a free slot (`printer_slots.assign`). No inventory spool is
 * involved; the material type and colour only describe it, and runs recorded on the slot count as customer material.
 */
export function MountCustomerFilamentModal({
  slot,
  unitName,
  onMounted,
  onClose,
}: {
  slot: PrinterSlot;
  unitName: string;
  onMounted: (slot: PrinterSlot) => void;
  onClose: () => void;
}) {
  const types = useQuery(materialTypesQuery());
  const options = typesForProcess(types.data, undefined)
    .filter((type) => type.unit === 'g')
    .map((type) => ({ id: type.id, label: type.name }));
  const [typeId, setTypeId] = useState<string | null>(null);
  const [colorName, setColorName] = useState('');
  const mutation = useMutation({
    mutationFn: () => mountCustomerFilament(slot.id, { materialTypeId: typeId, colorName: colorName.trim() || null }),
    onSuccess: onMounted,
  });
  return (
    <Modal
      open
      size="sm"
      modalLabel={`${unitName} · ${slot.name}`}
      modalHeading="Mount customer filament"
      primaryButtonText={mutation.isPending ? 'Mounting…' : 'Mount customer filament'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={() => mutation.mutate()}
    >
      <Stack gap={5}>
        <p>
          Filament the customer brought. Nothing is booked from stock, and prints recorded on this slot are recorded as
          customer material and not charged.
        </p>
        <FuzzySelectField
          autoAlign
          id="customer-filament-type"
          titleText="Material type (optional)"
          placeholder="Select a type"
          options={options}
          value={typeId}
          onChange={setTypeId}
        />
        <TextInput
          id="customer-filament-color"
          labelText="Colour (optional)"
          placeholder="For example Galaxy black"
          maxLength={80}
          value={colorName}
          onChange={(event) => setColorName(event.target.value)}
        />
        {mutation.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Not mounted"
            subtitle={saveError(mutation.error, 'The filament could not be mounted.').message}
          />
        )}
      </Stack>
    </Modal>
  );
}
