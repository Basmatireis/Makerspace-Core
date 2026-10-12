import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { Modal, Select, SelectItem, Stack, TextInput } from '@carbon/react';
import { identifierKinds, identifierLabel } from '../components/inventoryShared';
import { useSimulatedMutation, useStore } from '../store';
import type { IdentifierKind, Spool } from '../types';

type Values = { kind: IdentifierKind; value: string };

/** Adds a scannable identifier (NFC tag, barcode, ...) to a spool. */
export function IdentifierModal({ open, onClose, spool }: { open: boolean; onClose: () => void; spool: Spool }) {
  const store = useStore();
  const { mutate, pending } = useSimulatedMutation(store.addIdentifier);
  const { register, handleSubmit, reset, formState: { errors } } = useForm<Values>({ defaultValues: { kind: 'nfc', value: '' } });
  useEffect(() => { if (open) reset({ kind: 'nfc', value: '' }); }, [open, reset]);

  const submit = handleSubmit(async (values) => {
    await mutate(spool.id, values.kind, values.value.trim());
    store.notify({ kind: 'success', title: 'Identifier added', subtitle: `${identifierLabel(values.kind)} on ${spool.displayId}` });
    onClose();
  });

  const taken = (value: string) => store.spools.some((item) => item.identifiers.some((identifier) => identifier.value.toLowerCase() === value.trim().toLowerCase()));

  return (
    <Modal
      open={open} size="sm" modalHeading="Add identifier" modalLabel={spool.displayId}
      primaryButtonText={pending ? 'Adding…' : 'Add identifier'} secondaryButtonText="Cancel" primaryButtonDisabled={pending}
      preventCloseOnClickOutside shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
        <Stack gap={6}>
          <Select id="identifier-kind" labelText="Kind" {...register('kind')}>
            {identifierKinds.map((kind) => <SelectItem key={kind.id} value={kind.id} text={kind.label} />)}
          </Select>
          <TextInput
            id="identifier-value" labelText="Value" helperText="As printed or read by the scanner." autoComplete="off"
            invalid={Boolean(errors.value)} invalidText={errors.value?.message}
            {...register('value', { validate: (value) => !value.trim() ? 'Enter the identifier value.' : taken(value) ? 'This identifier is already assigned to a spool.' : true })}
          />
        </Stack>
      </form>
    </Modal>
  );
}
