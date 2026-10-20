import type { FilamentSpool, PrinterSlotStatus } from '../../../api/generated/models';
import { formatQuantity } from '../shared/format';

export const slotTag: Record<PrinterSlotStatus, { label: string; type: 'green' | 'warm-gray' | 'gray' }> = {
  available: { label: 'Available', type: 'green' },
  unavailable: { label: 'Unavailable', type: 'warm-gray' },
  retired: { label: 'Retired', type: 'gray' },
};

export const slotHeaders = [
  { key: 'slot', header: 'Slot' },
  { key: 'mapping', header: 'Printer slot' },
  { key: 'detected', header: 'Reported by printer' },
  { key: 'spool', header: 'Mounted spool' },
  { key: 'actions', header: 'Actions' },
];

export const runtimeTag = {
  connected: 'green',
  connecting: 'blue',
  degraded: 'purple',
  disconnected: 'red',
  disabled: 'gray',
} as const;

export const spoolLabel = (spool: FilamentSpool) =>
  `${spool.displayId}${spool.label ? ` (${spool.label})` : ''} · ${spool.materialName ?? 'No material'} · ${formatQuantity(spool.remainingQuantity)} ${spool.unit ?? 'g'} left`;
