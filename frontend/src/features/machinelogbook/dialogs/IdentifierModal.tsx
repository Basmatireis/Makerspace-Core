import { useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { InlineNotification, Modal, Select, SelectItem, Stack, TextInput } from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { addFilamentSpoolIdentifier } from '../../../api/generated/filament-spools/filament-spools';
import type { FilamentSpool, FilamentSpoolIdentifierKind } from '../../../api/generated/models';
import { identifierKey, identifierKinds, identifierLabel } from '../components/spoolShared';
import { useNotify } from '../shared/toasts';
import { errorCode, spoolErrorMessage, useRefreshInventory } from '../spoolData';

type Values = { kind: FilamentSpoolIdentifierKind; value: string };

/** Adds a scannable identifier (NFC tag, barcode, ...) to the open fill of a spool. */
export function IdentifierModal({ open, onClose, spool }: { open: boolean; onClose: () => void; spool: FilamentSpool }) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const mutation = useMutation({ mutationFn: (values: Values) => addFilamentSpoolIdentifier(spool.id, { kind: values.kind, value: values.value.trim() }) });
  const { register, handleSubmit, reset, setError, formState: { errors } } = useForm<Values>({ defaultValues: { kind: 'nfc', value: '' } });
  useEffect(() => { if (open) { reset({ kind: 'nfc', value: '' }); mutation.reset(); } }, [open, reset]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = mutation.isPending;

  const submit = handleSubmit(async (values) => {
    try {
      await mutation.mutateAsync(values);
    } catch (error) {
      if (errorCode(error) === 'identifier_in_use') setError('value', { message: 'This identifier is already assigned to a spool.' });
      return;
    }
    await refresh();
    notify({ kind: 'success', title: 'Identifier added', subtitle: `${identifierLabel(values.kind)} on ${spool.displayId}` });
    onClose();
  });

  const onThisSpool = (kind: string, value: string) => spool.identifiers.some((identifier) => identifierKey(identifier.kind, identifier.value) === identifierKey(kind, value));
  const otherError = mutation.isError && errorCode(mutation.error) !== 'identifier_in_use';

  return (
    <Modal
      open={open} size="sm" modalHeading="Add identifier" modalLabel={spool.displayId} aria-label={`Add identifier ${spool.displayId}`}
      primaryButtonText={pending ? 'Adding…' : 'Add identifier'} secondaryButtonText="Cancel" primaryButtonDisabled={pending}
      preventCloseOnClickOutside shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} noValidate>
        <Stack gap={6}>
          {otherError && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={spoolErrorMessage(mutation.error)} />}
          <Select id="identifier-kind" labelText="Kind" {...register('kind')}>
            {identifierKinds.map((kind) => <SelectItem key={kind.id} value={kind.id} text={kind.label} />)}
          </Select>
          <TextInput
            id="identifier-value" labelText="Value" helperText="As printed or read by the scanner." autoComplete="off"
            invalid={Boolean(errors.value)} invalidText={errors.value?.message}
            {...register('value', { validate: (value, form) => !value.trim() ? 'Enter the identifier value.' : onThisSpool(form.kind, value) ? 'This identifier is already on this spool.' : true })}
          />
        </Stack>
      </form>
    </Modal>
  );
}
