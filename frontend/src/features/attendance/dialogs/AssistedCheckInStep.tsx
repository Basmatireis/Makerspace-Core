import { Button, ComboBox, InlineNotification, ModalBody, ModalFooter, ModalHeader, Stack } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { supervisedVisitCheckIn } from '../../../api/generated/attendance/attendance';
import type { AttendanceHold } from '../../../api/generated/models';
import { useStableItems } from '../../../app/useStableItems';
import { attendanceKeys, candidatesOptions } from '../queries';
import { isHold } from '../presentation';

type Candidate = { id: string; label: string };

export function AssistedCheckInStep({
  excludedPersonIds,
  onCancel,
  onDone,
  onHeld,
}: {
  excludedPersonIds: ReadonlySet<string>;
  onCancel: () => void;
  onDone: () => void;
  onHeld: (hold: AttendanceHold) => void;
}) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [picked, setPicked] = useState<Candidate | null>(null);
  const candidates = useQuery(candidatesOptions(search, true));
  const items = useStableItems(
    (candidates.data?.items ?? [])
      .filter((person) => !excludedPersonIds.has(person.id))
      .map((person) => ({ id: person.id, label: `${person.firstName} ${person.lastName}` })),
  );
  // Selecting fills the input with the full name and searches again; the choice must stay selectable meanwhile.
  if (picked && !items.some((item) => item.id === picked.id)) items.unshift(picked);
  const checkIn = useMutation({
    mutationFn: (personId: string) => supervisedVisitCheckIn({ personId }),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: attendanceKeys.all });
      if (isHold(result)) onHeld(result);
      else onDone();
    },
  });

  return (
    <>
      <ModalHeader label="Assisted check-in" title="Check someone in" />
      <ModalBody>
        <Stack gap={5}>
          <ComboBox<Candidate>
            id="assisted-person"
            titleText="Person"
            placeholder="Search by name"
            items={items}
            itemToString={(item) => item?.label ?? ''}
            shouldFilterItem={() => true}
            selectedItem={picked}
            onInputChange={setSearch}
            onChange={({ selectedItem }) => setPicked(selectedItem ?? null)}
          />
          {candidates.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="People could not be loaded"
              subtitle={candidates.error.message}
            />
          )}
          {checkIn.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Check-in failed"
              subtitle={checkIn.error.message}
            />
          )}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" disabled={checkIn.isPending} onClick={onCancel}>
          Cancel
        </Button>
        <Button disabled={!picked || checkIn.isPending} onClick={() => picked && checkIn.mutate(picked.id)}>
          Check in
        </Button>
      </ModalFooter>
    </>
  );
}
