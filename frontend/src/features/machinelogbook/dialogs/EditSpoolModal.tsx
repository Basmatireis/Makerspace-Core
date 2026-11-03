import { useEffect } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { InlineNotification, Modal, Stack, TextArea, TextInput } from '@carbon/react';
import { useMutation } from '@tanstack/react-query';
import { updateFilamentSpool } from '../../../api/generated/filament-spools/filament-spools';
import type { FilamentSpool } from '../../../api/generated/models';
import { DateInput } from '../../../app/DateInput';
import { DecimalField } from '../../../app/DecimalField';
import { decimalNumber, decimalText, decimalValidator } from '../../../app/decimalInput';
import { useLatestCallback } from '../../../app/useLatestCallback';
import { toDecimal } from '../components/inventoryShared';
import { useNotify } from '../shared/toasts';
import { spoolErrorMessage, spoolUpdateBody, useRefreshInventory } from '../spoolData';

type Values = { tare: string; location: string; acquiredOn: string; reference: string; notes: string };

/**
 * Edits the descriptive fields of a spool. Its article and initial weight are fixed; the remainder changes through
 * weighing and bookings, and retiring has its own dialog.
 */
export function EditSpoolModal({ open, onClose, spool }: { open: boolean; onClose: () => void; spool: FilamentSpool }) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const defaults = (): Values => ({
    tare: decimalText(spool.tareWeightG),
    location: spool.storageLocation ?? '',
    acquiredOn: spool.acquiredOn ?? '',
    reference: spool.acquisitionReference ?? '',
    notes: spool.notes ?? '',
  });
  const { control, register, handleSubmit, reset } = useForm<Values>({ defaultValues: defaults() });
  const save = useMutation({
    mutationFn: (values: Values) => {
      const tare = decimalNumber(values.tare);
      return updateFilamentSpool(
        spool.id,
        spoolUpdateBody(spool, {
          tareWeightG: tare == null ? null : toDecimal(tare),
          storageLocation: values.location.trim() || null,
          acquiredOn: values.acquiredOn || null,
          acquisitionReference: values.reference.trim() || null,
          notes: values.notes.trim() || null,
        }),
      );
    },
    onSuccess: async (saved) => {
      notify({ kind: 'success', title: 'Spool saved', subtitle: saved.displayId });
      onClose();
      await refresh();
    },
    onError: () => {
      void refresh();
    },
  });
  const resetForm = useLatestCallback(() => {
    reset(defaults());
    save.reset();
  });
  useEffect(() => {
    if (open) resetForm();
  }, [open, spool.id, resetForm]);
  const pending = save.isPending;
  const submit = handleSubmit((values) => save.mutate(values));

  return (
    <Modal
      open={open}
      size="sm"
      modalLabel={spool.materialName}
      modalHeading={`Edit ${spool.displayId}`}
      primaryButtonText={pending ? 'Saving…' : 'Save spool'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => {
        void submit();
      }}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
        noValidate
      >
        <Stack gap={6}>
          {save.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Not saved"
              subtitle={spoolErrorMessage(save.error)}
            />
          )}
          <TextInput
            id="spool-location"
            labelText="Storage location (optional)"
            autoComplete="off"
            maxLength={200}
            {...register('location')}
          />
          <Controller
            control={control}
            name="tare"
            rules={{ validate: decimalValidator({ optional: true }) }}
            render={({ field, fieldState }) => (
              <DecimalField
                id="spool-tare"
                labelText="Tare weight in g (optional)"
                helperText="The empty spool, for weighing."
                value={field.value}
                onChange={field.onChange}
                invalid={fieldState.invalid}
                invalidText={fieldState.error?.message}
              />
            )}
          />
          <Controller
            control={control}
            name="acquiredOn"
            render={({ field }) => (
              <DateInput
                id="spool-acquired"
                labelText="Acquired on (optional)"
                value={field.value}
                onChange={field.onChange}
              />
            )}
          />
          <TextInput
            id="spool-reference"
            labelText="Acquisition reference (optional)"
            helperText="Invoice or order number."
            autoComplete="off"
            maxLength={200}
            {...register('reference')}
          />
          <TextArea id="spool-notes" labelText="Notes (optional)" rows={3} maxLength={2000} {...register('notes')} />
        </Stack>
      </form>
    </Modal>
  );
}
