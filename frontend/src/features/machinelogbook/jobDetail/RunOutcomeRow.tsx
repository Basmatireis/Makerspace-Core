import { useState } from 'react';
import { Button, Select, SelectItem, InlineNotification } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { updateMachineRun } from '../../../api/generated/machine-runs/machine-runs';
import type { MachineRun, MachineRunOutcome } from '../../../api/generated/models';
import { runOutcomeChoices } from '../dialogs/runFormHelpers';
import { machineLogbookKeys } from '../queries';
import { formatDateTime } from '../shared/format';
import { outcomeLabel } from '../shared/status';
import { useNotify } from '../shared/toasts';
import { errorText } from './jobDetailShared';

export function RunOutcomeRow({ run }: { run: MachineRun }) {
  const client = useQueryClient();
  const notify = useNotify();
  const [choice, setChoice] = useState<MachineRunOutcome | ''>('');
  const save = useMutation({
    mutationFn: (outcome: MachineRunOutcome) => updateMachineRun(run.id, { outcome, expectedVersion: run.version }),
    onSuccess: async (_saved, outcome) => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success',
        title: 'Outcome recorded',
        subtitle: `${run.displayId} is marked ${outcomeLabel(outcome).toLowerCase()}.`,
      });
    },
  });
  return (
    <div>
      {save.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Outcome not saved"
          subtitle={errorText(save.error, 'The outcome could not be saved.')}
        />
      )}
      <form
        className="mj-outcome-prompt__form"
        onSubmit={(event) => {
          event.preventDefault();
          if (choice) save.mutate(choice);
        }}
      >
        <Select
          id={`run-outcome-${run.id}`}
          labelText={`Outcome of ${run.displayId}`}
          helperText={`Ended ${run.endedAt ? formatDateTime(run.endedAt) : 'earlier'}`}
          value={choice}
          onChange={(event) => setChoice(event.target.value as MachineRunOutcome)}
        >
          <SelectItem value="" text="Select an outcome" hidden />
          {runOutcomeChoices.map((option) => (
            <SelectItem key={option.id} value={option.id} text={option.label} />
          ))}
        </Select>
        <Button type="submit" disabled={!choice || save.isPending}>
          {save.isPending ? 'Saving…' : 'Save outcome'}
        </Button>
      </form>
    </div>
  );
}
