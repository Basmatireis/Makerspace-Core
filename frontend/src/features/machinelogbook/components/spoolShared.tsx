/* eslint-disable react-refresh/only-export-components -- tags and the spool derivations they render form one module */
import { Link as CarbonLink, Tag } from '@carbon/react';
import { Link } from 'react-router-dom';
import type { FilamentSpool, FilamentSpoolIdentifierKind, FilamentSpoolKind, FilamentSpoolStatus, LeftoverOutcome } from '../../../api/generated/models';
import { machineLogbookPaths } from '../shared/paths';
import { formatGrams } from './inventoryShared';

/** API decimals arrive as strings; spool maths is done on numbers. */
export const toNumber = (value: string | number | null | undefined) => value == null || value === '' ? 0 : Number(value);


// Mount -------------------------------------------------------------------------

/** Where a spool sits right now: machine, then slot (the input unit is shown on the machine's printer tab). */
export const mountText = (mount: FilamentSpool['mountedOn']) => (mount ? `${mount.machineName} · ${mount.slotName}` : null);

/** Machine · slot, linking to the machine's printer tab. */
export function MountLink({ mount }: { mount: NonNullable<FilamentSpool['mountedOn']> }) {
  return <CarbonLink as={Link} to={machineLogbookPaths.machine(mount.machineId, 'printer')}>{mountText(mount)}</CarbonLink>;
}

/** Sentence fragment for dialogs that unmount the spool as a side effect. */
export const removedFromText = (spool: Pick<FilamentSpool, 'mounted' | 'mountedOn'>) => {
  if (!spool.mounted) return '';
  return spool.mountedOn ? ` It is also removed from ${spool.mountedOn.machineName} (${spool.mountedOn.slotName}).` : ' It is also removed from its printer slot.';
};

// Status ------------------------------------------------------------------------

/** Reusable spools are Loaded / Needs refill / Archived, single-use spools Active / Archived. */
const statusMeta: Record<FilamentSpoolStatus, { label: string; type: 'green' | 'warm-gray' | 'gray' }> = {
  loaded: { label: 'Loaded', type: 'green' },
  needs_refill: { label: 'Needs refill', type: 'warm-gray' },
  active: { label: 'Active', type: 'green' },
  archived: { label: 'Archived', type: 'gray' },
};
export const statusLabel = (status: FilamentSpoolStatus) => statusMeta[status].label;
export function StatusTag({ spool, size = 'md' }: { spool: Pick<FilamentSpool, 'status'>; size?: 'sm' | 'md' }) {
  const meta = statusMeta[spool.status];
  return <Tag type={meta.type} size={size}>{meta.label}</Tag>;
}
/** The status filter: "Active or loaded" covers both spool kinds. Archived spools have their own switch. */
export const statusOptions: { id: 'in_use' | 'needs_refill'; label: string }[] = [{ id: 'in_use', label: 'Active or loaded' }, { id: 'needs_refill', label: 'Needs refill' }];
export const matchesStatus = (spool: Pick<FilamentSpool, 'status'>, id: string) => id === 'needs_refill' ? spool.status === 'needs_refill' : spool.status === 'loaded' || spool.status === 'active';

export const kindOptions: { id: FilamentSpoolKind; label: string }[] = [{ id: 'reusable', label: 'Reusable' }, { id: 'single_use', label: 'Single-use' }];
export const kindLabel = (kind: FilamentSpoolKind) => kindOptions.find((item) => item.id === kind)?.label ?? kind;
export function KindTag({ kind, size = 'md' }: { kind: FilamentSpoolKind; size?: 'sm' | 'md' }) {
  return <Tag type={kind === 'reusable' ? 'blue' : 'cool-gray'} size={size}>{kindLabel(kind)}</Tag>;
}

export const outcomeLabel: Record<LeftoverOutcome, string> = { used_up: 'Used up', returned_to_stock: 'Returned to stock', disposed: 'Disposed' };
const outcomeType = { used_up: 'green', returned_to_stock: 'teal', disposed: 'red' } as const;
export function OutcomeTag({ outcome }: { outcome: LeftoverOutcome }) {
  return <Tag type={outcomeType[outcome]} size="sm">{outcomeLabel[outcome]}</Tag>;
}

// Spools ------------------------------------------------------------------------

/** A reusable spool without an open fill. */
export const needsRefill = (spool: Pick<FilamentSpool, 'status'>) => spool.status === 'needs_refill';
export const hasOpenFill = (spool: Pick<FilamentSpool, 'fillId'>) => Boolean(spool.fillId);
export const spoolNameText = (spool: Pick<FilamentSpool, 'displayId' | 'label'>) => spool.label ? `${spool.displayId} · ${spool.label}` : spool.displayId;
export const spoolTitle = (spool: Pick<FilamentSpool, 'manufacturer' | 'productName'>) => [spool.manufacturer, spool.productName].filter(Boolean).join(' ');
export const remainingOf = (spool: Pick<FilamentSpool, 'remainingQuantity'>) => toNumber(spool.remainingQuantity);
export const initialOf = (spool: Pick<FilamentSpool, 'initialNetWeightG'>) => toNumber(spool.initialNetWeightG);

/** Share of the initial net weight that is left, 0-100. */
export const spoolPercent = (spool: Pick<FilamentSpool, 'initialNetWeightG' | 'remainingQuantity'>) => initialOf(spool) > 0
  ? Math.max(0, Math.min(100, Math.round((remainingOf(spool) / initialOf(spool)) * 100))) : 0;
export const spoolIsLow = (spool: Pick<FilamentSpool, 'initialNetWeightG' | 'remainingQuantity' | 'status'>) => (spool.status === 'loaded' || spool.status === 'active') && initialOf(spool) > 0 && spoolPercent(spool) < 15;
export const spoolRemainingText = (spool: Pick<FilamentSpool, 'initialNetWeightG' | 'remainingQuantity' | 'status'>) => needsRefill(spool) ? 'Needs refill' : `${formatGrams(remainingOf(spool))} of ${formatGrams(initialOf(spool))}`;

export const identifierKinds: { id: FilamentSpoolIdentifierKind; label: string }[] = [{ id: 'nfc', label: 'NFC tag' }, { id: 'barcode', label: 'Barcode' }, { id: 'qr', label: 'QR code' }];
export const identifierLabel = (kind: FilamentSpoolIdentifierKind) => identifierKinds.find((item) => item.id === kind)?.label ?? kind;
/** Case-insensitive identity of an identifier, used to spot duplicates. */
export const identifierKey = (kind: string, value: string) => `${kind}:${value.trim().toLowerCase()}`;
