import { useEffect, useState } from 'react';
import {
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListHead,
  StructuredListRow,
  StructuredListWrapper,
} from '@carbon/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { cleanUpArchivedFilamentSpools } from '../../../api/generated/filament-spools/filament-spools';
import type { CleanUpFilamentSpoolsRequestOlderThanMonths } from '../../../api/generated/models';
import { formatDate } from '../../../app/dateTime';
import { useNotify } from '../shared/toasts';
import { spoolErrorMessage, useRefreshInventory } from '../spoolData';

const AGES: CleanUpFilamentSpoolsRequestOlderThanMonths[] = [1, 3, 6, 12];
const SHOWN = 5;
/** The API deletes at most this many spools per request. */
const MAX_PER_REQUEST = 500;

/** Hard-deletes archived single-use spools older than a chosen age. Their ledger entries and job usages keep the spool ID as text. */
export function CleanupSpoolsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const [months, setMonths] = useState<CleanUpFilamentSpoolsRequestOlderThanMonths>(3);
  useEffect(() => {
    if (open) setMonths(3);
  }, [open]);
  // The preview is a dry run on the server; what it lists is exactly what the confirmation deletes.
  const preview = useQuery({
    // Kept out of the shared inventory keys: a refresh after deleting must not run the dry run again.
    queryKey: ['spool-cleanup-preview', months],
    enabled: open,
    gcTime: 0,
    queryFn: ({ signal }) => cleanUpArchivedFilamentSpools({ olderThanMonths: months, dryRun: true }, { signal }),
  });
  const mutation = useMutation({
    mutationFn: (spoolIds: string[]) =>
      cleanUpArchivedFilamentSpools({ olderThanMonths: months, dryRun: false, spoolIds }),
  });
  const pending = mutation.isPending;
  const candidates = [...(preview.data?.items ?? [])]
    .sort((a, b) => a.archivedAt.localeCompare(b.archivedAt))
    .slice(0, MAX_PER_REQUEST);
  const total = preview.data?.items.length ?? 0;
  const matches = candidates.length;
  const ready = preview.isSuccess && !preview.isFetching;

  const confirm = async () => {
    try {
      const result = await mutation.mutateAsync(candidates.map((item) => item.id));
      await refresh();
      notify({
        kind: 'success',
        title: `${result.items.length} archived ${result.items.length === 1 ? 'spool' : 'spools'} deleted`,
        subtitle: 'Usage history stays on materials and jobs.',
      });
      onClose();
    } catch {
      await refresh();
    }
  };

  return (
    <Modal
      open={open}
      danger
      size="md"
      modalHeading="Clean up archived spools"
      primaryButtonText={
        pending ? 'Deleting…' : matches > 0 ? `Delete ${matches} ${matches === 1 ? 'spool' : 'spools'}` : 'Delete'
      }
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || !ready || matches === 0}
      preventCloseOnClickOutside
      shouldSubmitOnEnter={false}
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onSecondarySubmit={() => {
        if (!pending) onClose();
      }}
      onRequestSubmit={() => {
        void confirm();
      }}
    >
      <Stack gap={6}>
        <Select
          id="cleanup-age"
          labelText="Archived"
          helperText="Only single-use spools are cleaned up. Reusable spools are never deleted automatically."
          value={String(months)}
          onChange={(event) => {
            mutation.reset();
            setMonths(Number(event.target.value) as CleanUpFilamentSpoolsRequestOlderThanMonths);
          }}
        >
          {AGES.map((age) => (
            <SelectItem key={age} value={String(age)} text={`Older than ${age} ${age === 1 ? 'month' : 'months'}`} />
          ))}
        </Select>
        {mutation.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Not deleted"
            subtitle={spoolErrorMessage(
              mutation.error,
              'The spools could not be deleted. Check the list and try again.',
            )}
          />
        )}
        {preview.isError ? (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Not loaded"
            subtitle="The matching spools could not be loaded. Close the dialog and try again."
          />
        ) : !ready ? (
          <p className="mj-secondary">Looking for archived single-use spools…</p>
        ) : matches === 0 ? (
          <p>
            No archived single-use spools are older than {months} {months === 1 ? 'month' : 'months'}.
          </p>
        ) : (
          <>
            <p>
              {matches} archived single-use {matches === 1 ? 'spool matches' : 'spools match'} and will be deleted
              permanently.
            </p>
            <StructuredListWrapper isCondensed aria-label="Spools that will be deleted">
              <StructuredListHead>
                <StructuredListRow head>
                  <StructuredListCell head>Spool</StructuredListCell>
                  <StructuredListCell head>Label</StructuredListCell>
                  <StructuredListCell head>Archived</StructuredListCell>
                </StructuredListRow>
              </StructuredListHead>
              <StructuredListBody>
                {candidates.slice(0, SHOWN).map((spool) => (
                  <StructuredListRow key={spool.id}>
                    <StructuredListCell>{spool.displayId}</StructuredListCell>
                    <StructuredListCell>{spool.label || '—'}</StructuredListCell>
                    <StructuredListCell>{formatDate(spool.archivedAt)}</StructuredListCell>
                  </StructuredListRow>
                ))}
              </StructuredListBody>
            </StructuredListWrapper>
            {matches > SHOWN && <p className="mj-secondary">and {matches - SHOWN} more</p>}
            {total > matches && (
              <p className="mj-secondary">
                {total - matches} more can be cleaned up afterwards; up to {MAX_PER_REQUEST} spools are deleted at a
                time.
              </p>
            )}
          </>
        )}
        <p>Their usage history stays on materials and jobs (spool IDs remain as text).</p>
      </Stack>
    </Modal>
  );
}
