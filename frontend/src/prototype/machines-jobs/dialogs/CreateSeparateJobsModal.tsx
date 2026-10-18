import { useEffect, useState } from 'react';
import { ComboBox, Modal, Select, SelectItem, Stack, StructuredListBody, StructuredListCell, StructuredListHead, StructuredListRow, StructuredListWrapper } from '@carbon/react';
import { formatDateTime } from '../derived';
import { usageListText } from '../runs';
import { lookups, useSimulatedMutation, useStore, type SeparateJobsShared } from '../store';
import { resolveGroup } from '../sales/pricing';
import type { BillingParty, Operator, Print } from '../types';
import { matchesName } from './jobFormHelpers';

/** One job per selected unassigned run; customer and operator (and optionally a pricing group) are shared. */
export function CreateSeparateJobsModal({ open, onClose, runs, onDone }: { open: boolean; onClose: () => void; runs: Print[]; onDone: () => void }) {
  const store = useStore();
  const [customer, setCustomer] = useState<BillingParty | null>(null);
  const [operator, setOperator] = useState<Operator | null>(null);
  const [group, setGroup] = useState('');
  useEffect(() => { if (open) { setCustomer(null); setOperator(null); setGroup(''); } }, [open]);
  const resolved = customer ? resolveGroup(store.pricing, store.organizations, customer) : null;
  const { mutate, pending } = useSimulatedMutation((ids: string[], shared: SeparateJobsShared) => store.createSeparateJobs(ids, shared));

  const submit = async () => {
    if (!customer || !operator) return;
    const jobs = await mutate(runs.map((run) => run.id), { customer, operator, pricingGroup: group || null });
    store.notify({ kind: 'success', title: `${jobs.length} jobs created`, subtitle: `${jobs.map((job) => job.displayId).join(', ')} — each job uses the data of its run.`, action: { label: 'View jobs', to: `/jobs?customer=${customer.id}` } });
    onDone();
    onClose();
  };

  return (
    <Modal
      open={open} size="md" modalHeading={`Create ${runs.length} separate jobs`} secondaryButtonText="Cancel" primaryButtonText={pending ? 'Creating…' : `Create ${runs.length} jobs`}
      primaryButtonDisabled={!customer || !operator || pending} preventCloseOnClickOutside onRequestClose={() => { if (!pending) onClose(); }} onRequestSubmit={() => { void submit(); }}
    >
      <Stack gap={5}>
        <p>Every selected run becomes its own job. The fields below apply to all of them.</p>
        <ComboBox autoAlign
          id="separate-customer" titleText="Customer" placeholder="Search people or organizations" items={lookups.people} itemToString={(item) => item?.displayName ?? ''}
          shouldFilterItem={matchesName} selectedItem={customer} onChange={({ selectedItem }) => setCustomer(selectedItem ?? null)}
          helperText="Every job needs a customer, an account or an organization."
        />
        <ComboBox autoAlign
          id="separate-operator" titleText="Operator" placeholder="Search operators" items={lookups.operators} itemToString={(item) => item?.displayName ?? ''}
          shouldFilterItem={matchesName} selectedItem={operator} onChange={({ selectedItem }) => setOperator(selectedItem ?? null)}
        />
        <Select id="separate-pricing-group" labelText="Pricing group (optional)" helperText={resolved ? `Leave empty to price the jobs with ${resolved.group.name} (${resolved.reason}).` : 'Leave empty to price the jobs by the customer.'} value={group} onChange={(event) => setGroup(event.target.value)}>
          <SelectItem value="" text="By the customer" />
          {store.pricing.groups.filter((item) => item.active).map((item) => <SelectItem key={item.id} value={item.name} text={item.name} />)}
        </Select>
        <StructuredListWrapper isCondensed aria-label="Jobs that will be created">
          <StructuredListHead>
            <StructuredListRow head>
              <StructuredListCell head>Job name (run file)</StructuredListCell>
              <StructuredListCell head>Started</StructuredListCell>
              <StructuredListCell head>Material</StructuredListCell>
            </StructuredListRow>
          </StructuredListHead>
          <StructuredListBody>
            {runs.map((run) => (
              <StructuredListRow key={run.id}>
                <StructuredListCell>{run.fileName}</StructuredListCell>
                <StructuredListCell>{formatDateTime(run.startedAt)}</StructuredListCell>
                <StructuredListCell>{usageListText(run.reportedUsage ? [run.reportedUsage] : [])}</StructuredListCell>
              </StructuredListRow>
            ))}
          </StructuredListBody>
        </StructuredListWrapper>
      </Stack>
    </Modal>
  );
}
