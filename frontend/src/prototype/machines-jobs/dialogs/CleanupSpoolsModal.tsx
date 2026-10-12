import { useEffect, useState } from 'react';
import { Modal, Select, SelectItem, Stack, StructuredListBody, StructuredListCell, StructuredListHead, StructuredListRow, StructuredListWrapper } from '@carbon/react';
import { formatDate } from '../../../app/dateTime';
import { cleanupCandidates, monthsAgoIso } from '../components/inventoryShared';
import { useSimulatedMutation, useStore } from '../store';

const AGES = [1, 3, 6, 12];
const SHOWN = 5;

/** Hard-deletes archived single-use spools older than a chosen age. Their ledger entries and job usages keep the spool ID as text. */
export function CleanupSpoolsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const store = useStore();
  const [months, setMonths] = useState(3);
  const { mutate, pending } = useSimulatedMutation(store.deleteArchivedSpools);
  useEffect(() => { if (open) setMonths(3); }, [open]);
  const matches = cleanupCandidates(store.spools, months).sort((a, b) => (a.archivedAt ?? '').localeCompare(b.archivedAt ?? ''));

  return (
    <Modal
      open={open} danger size="md" modalHeading="Clean up archived spools"
      primaryButtonText={pending ? 'Deleting…' : matches.length > 0 ? `Delete ${matches.length} ${matches.length === 1 ? 'spool' : 'spools'}` : 'Delete'}
      secondaryButtonText="Cancel" primaryButtonDisabled={pending || matches.length === 0} preventCloseOnClickOutside shouldSubmitOnEnter={false}
      onRequestClose={() => { if (!pending) onClose(); }} onSecondarySubmit={() => { if (!pending) onClose(); }}
      onRequestSubmit={async () => {
        const removed = await mutate(monthsAgoIso(months));
        store.notify({ kind: 'success', title: `${removed.length} archived ${removed.length === 1 ? 'spool' : 'spools'} deleted`, subtitle: 'Usage history stays on materials and jobs.' });
        onClose();
      }}
    >
      <Stack gap={6}>
        <Select id="cleanup-age" labelText="Archived" helperText="Only single-use spools are cleaned up. Reusable spools are never deleted automatically." value={String(months)} onChange={(event) => setMonths(Number(event.target.value))}>
          {AGES.map((age) => <SelectItem key={age} value={String(age)} text={`Older than ${age} ${age === 1 ? 'month' : 'months'}`} />)}
        </Select>
        {matches.length === 0 ? (
          <p>No archived single-use spools are older than {months} {months === 1 ? 'month' : 'months'}.</p>
        ) : (
          <>
            <p>{matches.length} archived single-use {matches.length === 1 ? 'spool matches' : 'spools match'} and will be deleted permanently.</p>
            <StructuredListWrapper isCondensed aria-label="Spools that will be deleted">
              <StructuredListHead>
                <StructuredListRow head>
                  <StructuredListCell head>Spool</StructuredListCell>
                  <StructuredListCell head>Last material</StructuredListCell>
                  <StructuredListCell head>Archived</StructuredListCell>
                </StructuredListRow>
              </StructuredListHead>
              <StructuredListBody>
                {matches.slice(0, SHOWN).map((spool) => (
                  <StructuredListRow key={spool.id}>
                    <StructuredListCell>{spool.displayId}</StructuredListCell>
                    <StructuredListCell>{spool.materialName || '—'}</StructuredListCell>
                    <StructuredListCell>{spool.archivedAt ? formatDate(spool.archivedAt) : '—'}</StructuredListCell>
                  </StructuredListRow>
                ))}
              </StructuredListBody>
            </StructuredListWrapper>
            {matches.length > SHOWN && <p className="mj-secondary">and {matches.length - SHOWN} more</p>}
          </>
        )}
        <p>Their usage history stays on materials and jobs (spool IDs remain as text).</p>
      </Stack>
    </Modal>
  );
}
