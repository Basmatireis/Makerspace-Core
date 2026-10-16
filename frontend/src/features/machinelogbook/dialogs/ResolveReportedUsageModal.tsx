import { useState } from 'react';
import { Button, ComposedModal, InlineNotification, ModalBody, ModalFooter, ModalHeader, NumberInput, Select, SelectItem, Stack } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { replaceMachineRunUsages } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineRun, MachineRunReportedUsageItem } from '../../../api/generated/models';
import { machineLogbookKeys, spoolsQuery } from '../queries';
import { formatQuantity } from '../shared/format';
import { useNotify } from '../shared/toasts';
import { saveError, toUsageInputs, usageRowsFromUsages } from './jobFormHelpers';

type Values = { spoolId: string; quantity: number | '' };

const itemName = (item: MachineRunReportedUsageItem) => item.slicerFilamentId
  ? `filament ${item.slicerFilamentId}`
  : `reported line ${item.lineNumber + 1}`;

/** Maps one unresolved machine-report line to a physical Core spool. */
export function ResolveReportedUsageModal({ open, onClose, run, item }: {
  open: boolean;
  onClose: () => void;
  run: MachineRun;
  item: MachineRunReportedUsageItem;
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const [error, setError] = useState<string | null>(null);
  const reportedQuantity = item.estimatedQuantityGrams ?? item.plannedQuantityGrams ?? '';
  const form = useForm<Values>({ defaultValues: { spoolId: '', quantity: reportedQuantity === '' ? '' : Number(reportedQuantity) } });
  const spools = useQuery({ ...spoolsQuery({ consumable: true, page: 1, pageSize: 100 }), enabled: open });
  const alreadyUsed = new Set(run.usages.map((usage) => usage.spoolId).filter(Boolean));
  const choices = (spools.data?.items ?? []).filter((spool) => spool.materialId && spool.unit === 'g' && !alreadyUsed.has(spool.id));

  const mutation = useMutation({
    mutationFn: ({ spoolId, quantity }: Values) => {
      const spool = choices.find((candidate) => candidate.id === spoolId);
      if (!spool?.materialId || quantity === '') throw new Error('Choose a spool and enter a quantity.');
      const usages = usageRowsFromUsages(run.usages);
      usages.push({
        ownership: 'makerspace', materialId: spool.materialId, spoolId: spool.id, externalName: '', quantity,
        quantityBasis: 'estimated', materialLabel: spool.materialName ?? undefined, spoolLabel: spool.displayId,
      });
      return replaceMachineRunUsages(run.id, { usages: toUsageInputs(usages), expectedVersion: run.version });
    },
    onSuccess: async (_result, values) => {
      const spool = choices.find((candidate) => candidate.id === values.spoolId);
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success', title: 'Reported material mapped',
        subtitle: `${formatQuantity(values.quantity)} g was assigned to ${spool?.displayId ?? 'the selected spool'}; stock and calculated pricing were updated.`,
      });
      onClose();
    },
    onError: (cause) => setError(saveError(cause, cause instanceof Error ? cause.message : 'The reported material could not be mapped.').message),
  });

  const submit = form.handleSubmit((values) => { setError(null); mutation.mutate(values); });
  if (!open) return null;

  return (
    <ComposedModal open size="md" preventCloseOnClickOutside onClose={() => { if (!mutation.isPending) onClose(); return false; }} aria-label="Map reported material">
      <ModalHeader title="Map reported material" label={run.displayId} />
      <ModalBody hasForm>
        <Stack gap={6}>
          <p>
            The printer reported {reportedQuantity === '' ? 'an unknown quantity of' : `${formatQuantity(reportedQuantity)} g of`} {itemName(item)},
            but could not identify its physical spool. Choose the spool that was actually used.
          </p>
          <InlineNotification
            kind="info" lowContrast hideCloseButton title="Recorded as a staff correction"
            subtitle="The original machine report is retained. Saving consumes stock from the selected spool, recalculates the job price, and prevents later connector reports from overwriting the correction."
          />
          {error && <InlineNotification kind="error" lowContrast hideCloseButton title="Material not mapped" subtitle={error} />}
          {spools.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Spools unavailable" subtitle="The spool list could not be loaded." />}
          <Controller
            control={form.control} name="spoolId" rules={{ required: true }}
            render={({ field, fieldState }) => (
              <Select id="reported-material-spool" labelText="Spool used" value={field.value} onChange={field.onChange} invalid={fieldState.invalid} invalidText="Choose the spool that was used.">
                <SelectItem value="" text={spools.isPending ? 'Loading spools…' : 'Select a spool'} />
                {choices.map((spool) => (
                  <SelectItem key={spool.id} value={spool.id} text={`${spool.displayId}${spool.label ? ` · ${spool.label}` : ''} · ${spool.materialName ?? 'Unknown material'} · ${formatQuantity(spool.remainingQuantity)} g left`} />
                ))}
              </Select>
            )}
          />
          <Controller
            control={form.control} name="quantity" rules={{ validate: (value) => Number(value) > 0 }}
            render={({ field, fieldState }) => (
              <NumberInput
                id="reported-material-quantity" label="Consumed quantity (g)" allowEmpty min={0} step={0.01} hideSteppers
                value={field.value} invalid={fieldState.invalid} invalidText="Enter a quantity above zero."
                helperText="The connector's estimate is prefilled; change it only if you have a better measurement."
                onChange={(_event, state) => field.onChange(state.value === '' ? '' : Number(state.value))}
              />
            )}
          />
          {!spools.isPending && choices.length === 0 && <p className="mj-secondary">No unused consumable filament spool is available. Add or refill the spool in Inventory first.</p>}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" disabled={mutation.isPending} onClick={onClose}>Cancel</Button>
        <Button kind="primary" disabled={mutation.isPending || choices.length === 0} onClick={submit}>{mutation.isPending ? 'Saving…' : 'Map and consume'}</Button>
      </ModalFooter>
    </ComposedModal>
  );
}
