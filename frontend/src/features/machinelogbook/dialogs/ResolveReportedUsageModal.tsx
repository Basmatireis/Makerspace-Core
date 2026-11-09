import { useState } from 'react';
import { Button, ComposedModal, InlineNotification, ModalBody, ModalFooter, ModalHeader, Stack } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FormProvider, useForm } from 'react-hook-form';
import { replaceMachineRunUsages } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineRun, MachineRunReportedUsageItem, Process } from '../../../api/generated/models';
import { decimalText, parseDecimalText } from '../../../app/decimalInput';
import { machineLogbookKeys, machineQuery } from '../queries';
import { formatQuantity } from '../shared/format';
import { useCan } from '../shared/useCan';
import { useNotify } from '../shared/toasts';
import { reportedLineName } from '../jobs/runLines';
import {
  blankUsage,
  hasMaterial,
  saveError,
  toUsageInputs,
  usageRowsFromUsages,
  type UsagesValues,
} from './jobFormHelpers';
import { UsageRowsEditor } from './UsageFormModal';

/**
 * Books one unresolved machine-report line: a stock article (optionally its spool) or the recipient's own material,
 * chosen in the same catalog picker as the usage editor. The connector's estimate is prefilled.
 */
export function ResolveReportedUsageModal({
  open,
  onClose,
  run,
  item,
}: {
  open: boolean;
  onClose: () => void;
  run: MachineRun;
  item: MachineRunReportedUsageItem;
}) {
  const can = useCan();
  const machine = useQuery({ ...machineQuery(run.machineId), enabled: open && can('machines.read') });
  if (!open || (can('machines.read') && machine.isPending)) return null;
  return <ResolveForm onClose={onClose} run={run} item={item} process={machine.data?.process} />;
}

function ResolveForm({
  onClose,
  run,
  item,
  process,
}: {
  onClose: () => void;
  run: MachineRun;
  item: MachineRunReportedUsageItem;
  process?: Process;
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const reportedQuantity = item.estimatedQuantityGrams ?? item.plannedQuantityGrams ?? '';
  const form = useForm<UsagesValues>({
    defaultValues: {
      usages: [{ ...blankUsage(), quantity: decimalText(reportedQuantity), quantityBasis: 'estimated' }],
    },
  });

  const mutation = useMutation({
    mutationFn: ({ usages: [row] }: UsagesValues) =>
      replaceMachineRunUsages(run.id, {
        usages: toUsageInputs([...usageRowsFromUsages(run.usages), row]),
        expectedVersion: run.version,
      }),
    onSuccess: async (_result, { usages: [row] }) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      const quantity = formatQuantity(parseDecimalText(row.quantity) ?? '');
      notify({
        kind: 'success',
        title: 'Reported material mapped',
        subtitle:
          row.ownership === 'external'
            ? `${quantity} g recorded as the recipient’s own material; not charged.`
            : `${quantity} g of ${row.materialLabel ?? 'the selected material'} booked; stock and calculated pricing were updated.`,
      });
      onClose();
    },
    onError: (cause) => setError(saveError(cause, 'The reported material could not be mapped.').message),
  });

  const submit = form.handleSubmit(
    (values) => {
      setError(null);
      mutation.mutate(values);
    },
    () => setError('Choose the material and enter a quantity above zero.'),
  );

  return (
    <ComposedModal
      open={!picking}
      size="md"
      preventCloseOnClickOutside
      onClose={() => {
        if (!mutation.isPending) onClose();
        return false;
      }}
      aria-label="Map reported material"
    >
      <ModalHeader title="Map reported material" label={run.displayId} />
      <ModalBody hasForm>
        <FormProvider {...form}>
          <Stack gap={6}>
            <p>
              The printer reported{' '}
              {reportedQuantity === '' ? 'an unknown quantity' : `${formatQuantity(reportedQuantity)} g`} for{' '}
              {reportedLineName(item)}, but could not identify the material. Choose what was actually used: an article
              from stock, optionally with its spool, or the recipient’s own material.
            </p>
            <InlineNotification
              kind="info"
              lowContrast
              hideCloseButton
              title="Recorded as a staff correction"
              subtitle="The original machine report is retained. Stock material is consumed and priced; the recipient’s own material is never charged. Later connector reports do not overwrite the correction."
            />
            {error && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Material not mapped"
                subtitle={error}
              />
            )}
            <UsageRowsEditor idPrefix="reported-material" process={process} onPickingChange={setPicking} single />
          </Stack>
        </FormProvider>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" disabled={mutation.isPending} onClick={onClose}>
          Cancel
        </Button>
        <Button kind="primary" disabled={mutation.isPending || !hasMaterial(form.watch('usages.0'))} onClick={submit}>
          {mutation.isPending ? 'Saving…' : 'Map material'}
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}
