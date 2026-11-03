import { useState } from 'react';
import { InlineNotification, Modal, Stack, TextInput } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { replaceMachineRunUsages } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineRun, MachineRunReportedUsageItem } from '../../../api/generated/models';
import { FuzzySelectField } from '../../../app/components/FuzzyComboBox';
import { DecimalField } from '../../../app/DecimalField';
import { decimalText, parseDecimalText } from '../../../app/decimalInput';
import { saveError, toUsageInputs, usageRowsFromUsages } from '../dialogs/jobFormHelpers';
import { typesForProcess } from '../dialogs/MaterialPickerModal';
import { materialTypesQuery } from '../inventoryQueries';
import { machineLogbookKeys } from '../queries';
import { formatQuantity } from '../shared/format';
import { useNotify } from '../shared/toasts';
import { reportedLineName, reportedLineQuantity } from './runLines';

function RecipientMaterialForm({
  run,
  item,
  onClose,
}: {
  run: MachineRun;
  item: MachineRunReportedUsageItem;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const notify = useNotify();
  const reported = reportedLineQuantity(item);
  const [label, setLabel] = useState('');
  const [quantity, setQuantity] = useState(reported == null ? '' : decimalText(reported));
  const types = useQuery(materialTypesQuery());
  const options = typesForProcess(types.data, undefined)
    .filter((type) => type.unit === 'g')
    .map((type) => ({ id: type.id, label: type.name }));
  const [typeId, setTypeId] = useState<string | null>(null);
  const parsed = parseDecimalText(quantity);
  const mutation = useMutation({
    mutationFn: () => {
      const rows = usageRowsFromUsages(run.usages);
      rows.push({
        ownership: 'external',
        materialId: '',
        spoolId: '',
        externalName: label.trim(),
        materialTypeId: typeId ?? '',
        quantity: parsed ?? '',
        quantityBasis: 'estimated',
      });
      return replaceMachineRunUsages(run.id, { usages: toUsageInputs(rows), expectedVersion: run.version });
    },
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success',
        title: 'Recipient material recorded',
        subtitle: `${reportedLineName(item)} · ${formatQuantity(parsed ?? 0)} g · not charged`,
      });
      onClose();
    },
  });
  const valid = parsed !== null && Number(parsed) > 0 && Boolean(label.trim() || typeId);
  return (
    <Modal
      open
      size="sm"
      modalHeading="Recipient brought this material"
      modalLabel={`${run.displayId} · ${reportedLineName(item)}`}
      primaryButtonText={mutation.isPending ? 'Saving…' : 'Record as recipient material'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={!valid || mutation.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={() => mutation.mutate()}
    >
      <Stack gap={5}>
        <dl className="jobs-summary">
          <div>
            <dt>Reported</dt>
            <dd>
              {reportedLineName(item)} · {reported == null ? 'unknown quantity' : `${formatQuantity(reported)} g`}
            </dd>
          </div>
        </dl>
        {mutation.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Not recorded"
            subtitle={saveError(mutation.error, 'The material could not be recorded.').message}
          />
        )}
        <TextInput
          id="recipient-line-label"
          labelText="Label"
          placeholder="For example PLA · Sunlu"
          helperText="What the recipient brought; shown on the run and the job."
          maxLength={200}
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <div className="mj-form-grid">
          <FuzzySelectField
            id="recipient-line-type"
            titleText="Category"
            placeholder="Select a category"
            options={options}
            value={typeId}
            onChange={setTypeId}
          />
          <DecimalField
            id="recipient-line-quantity"
            labelText="Quantity (g)"
            value={quantity}
            invalid={quantity.trim() !== '' && parsed === null}
            invalidText="Enter a number, e.g. 12,5."
            onChange={setQuantity}
          />
        </div>
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Never charged"
          subtitle="Nothing is booked from stock and no material is charged; runtime is charged as usual."
        />
      </Stack>
    </Modal>
  );
}

/** Records one unresolved report line of a recorded run as material the recipient brought. */
export function RecipientMaterialModal({
  run,
  item,
  onClose,
}: {
  run: MachineRun;
  item: MachineRunReportedUsageItem | null;
  onClose: () => void;
}) {
  return item ? <RecipientMaterialForm run={run} item={item} onClose={onClose} /> : null;
}
