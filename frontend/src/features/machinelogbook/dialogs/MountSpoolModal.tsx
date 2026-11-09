import { useState } from 'react';
import { InlineNotification, Modal, Stack } from '@carbon/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { FilamentSpool, PrinterSlot } from '../../../api/generated/models';
import { mountPrinterSpool } from '../../../api/generated/printing/printing';
import { FuzzySelectField } from '../../../app/components/FuzzyComboBox';
import { isFdm } from '../processConfig';
import { machinesQuery, printerQuery } from '../queries';
import { useNotify } from '../shared/toasts';
import { spoolErrorMessage, useRefreshInventory } from '../spoolData';

const slotText = (slot: PrinterSlot) =>
  `${slot.inputUnitName} · ${slot.name}${slot.spoolDisplayId ? ` (holds ${slot.spoolDisplayId})` : ''}`;

/** Mounts a spool in a free slot of an FDM printer (`printer_slots.assign`). */
export function MountSpoolModal({ spool, onClose }: { spool: FilamentSpool; onClose: () => void }) {
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const [machineId, setMachineId] = useState<string | null>(null);
  const [slotId, setSlotId] = useState<string | null>(null);
  const machines = useQuery(machinesQuery({ pageSize: 100 }));
  const printers = (machines.data?.items ?? []).filter((machine) => isFdm(machine.process));
  const profile = useQuery({ ...printerQuery(machineId ?? ''), enabled: Boolean(machineId) });
  const slots = (profile.data?.slots ?? []).filter((slot) => slot.status !== 'retired');
  const free = slots.filter((slot) => !slot.assignmentId);
  const mount = useMutation({
    mutationFn: (slot: PrinterSlot) => mountPrinterSpool(slot.id, { spoolId: spool.id }),
    onSuccess: async (slot) => {
      notify({
        kind: 'success',
        title: `${spool.displayId} mounted`,
        subtitle: `${slot.inputUnitName} · ${slot.name}`,
      });
      onClose();
      await refresh();
    },
    onError: () => {
      void refresh();
    },
  });
  const chosen = free.find((slot) => slot.id === slotId);

  return (
    <Modal
      open
      size="sm"
      modalLabel={`${spool.displayId} · ${spool.materialName}`}
      modalHeading="Mount spool"
      primaryButtonText={mount.isPending ? 'Mounting…' : 'Mount spool'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mount.isPending || !chosen}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mount.isPending) onClose();
      }}
      onRequestSubmit={() => {
        if (chosen) mount.mutate(chosen);
      }}
    >
      <Stack gap={6}>
        {spool.mounted && (
          <p>
            The spool is mounted in {spool.mountedOn?.machineName ?? 'a printer'} now; mounting it elsewhere moves it.
          </p>
        )}
        <FuzzySelectField
          autoAlign
          id="mount-machine"
          titleText="Printer"
          placeholder="Choose a printer"
          options={printers.map((machine) => ({ id: machine.id, label: machine.name }))}
          value={machineId}
          helperText={machines.isSuccess && printers.length === 0 ? 'No FDM printer is set up.' : undefined}
          onChange={(id) => {
            setMachineId(id);
            setSlotId(null);
          }}
        />
        {machineId && (
          <FuzzySelectField
            autoAlign
            id="mount-slot"
            titleText="Slot"
            placeholder="Choose a free slot"
            options={free.map((slot) => ({ id: slot.id, label: slotText(slot) }))}
            value={slotId}
            helperText={
              profile.isError
                ? 'The printer setup could not be loaded.'
                : profile.isSuccess && free.length === 0
                  ? 'Every slot of this printer holds a spool. Unmount one first.'
                  : undefined
            }
            onChange={setSlotId}
          />
        )}
        {mount.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Not mounted"
            subtitle={spoolErrorMessage(mount.error)}
          />
        )}
      </Stack>
    </Modal>
  );
}
