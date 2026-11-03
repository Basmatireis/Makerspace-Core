/* eslint-disable react-refresh/only-export-components -- tags and the spool derivations they render form one module */
import { Link as CarbonLink, ProgressBar, Tag } from '@carbon/react';
import { Link } from 'react-router-dom';
import type {
  FilamentSpool,
  FilamentSpoolIdentifierKind,
  Material,
  SpoolRetireOutcome,
} from '../../../api/generated/models';
import { machineLogbookPaths } from '../shared/paths';
import { formatGrams } from './inventoryShared';

/** API decimals arrive as strings; spool maths is done on numbers. */
export const toNumber = (value: string | number | null | undefined) =>
  value == null || value === '' ? 0 : Number(value);

// Mount -------------------------------------------------------------------------

/** Where a spool sits right now: machine, input unit and slot. */
export const mountText = (mount: FilamentSpool['mountedOn']) =>
  mount ? [mount.machineName, mount.inputUnitName, mount.slotName].filter(Boolean).join(' · ') : null;

/** Machine · unit · slot, linking to the machine's printer tab. */
export function MountLink({ mount }: { mount: NonNullable<FilamentSpool['mountedOn']> }) {
  return (
    <CarbonLink as={Link} to={machineLogbookPaths.machine(mount.machineId, 'printer')}>
      {mountText(mount)}
    </CarbonLink>
  );
}

/** Where to find the spool: its mount, else its storage location. */
export const whereText = (spool: Pick<FilamentSpool, 'mountedOn' | 'mounted' | 'storageLocation' | 'lifecycle'>) =>
  spool.lifecycle === 'archived'
    ? 'Retired'
    : (mountText(spool.mountedOn) ?? (spool.mounted ? 'Mounted' : spool.storageLocation || 'No location'));

// State -------------------------------------------------------------------------

export const isRetired = (spool: Pick<FilamentSpool, 'lifecycle'>) => spool.lifecycle === 'archived';

/** Mounted, in storage, or retired (in the recycle bin). */
export function SpoolStateTag({
  spool,
  size = 'md',
}: {
  spool: Pick<FilamentSpool, 'lifecycle' | 'mounted'>;
  size?: 'sm' | 'md';
}) {
  if (isRetired(spool))
    return (
      <Tag type="gray" size={size}>
        Retired
      </Tag>
    );
  return spool.mounted ? (
    <Tag type="green" size={size}>
      Mounted
    </Tag>
  ) : (
    <Tag type="blue" size={size}>
      In storage
    </Tag>
  );
}

export const retireOutcomeText = (spool: Pick<FilamentSpool, 'retiredOutcome' | 'retiredQuantity'>): string | null => {
  if (!spool.retiredOutcome) return null;
  const quantity = toNumber(spool.retiredQuantity);
  return spool.retiredOutcome === 'empty'
    ? quantity > 0
      ? `Ran empty, ${formatGrams(quantity)} booked as used`
      : 'Ran empty'
    : `${formatGrams(quantity)} thrown away`;
};

export const retireOutcomeLabel: Record<SpoolRetireOutcome, string> = {
  empty: 'Ran empty',
  discarded: 'Rest thrown away',
};

// Quantities --------------------------------------------------------------------

export const remainingOf = (spool: Pick<FilamentSpool, 'remainingQuantity'>) => toNumber(spool.remainingQuantity);
export const initialOf = (spool: Pick<FilamentSpool, 'initialNetWeightG'>) => toNumber(spool.initialNetWeightG);

/** Share of the initial net weight that is left, 0-100. */
export const spoolPercent = (spool: Pick<FilamentSpool, 'initialNetWeightG' | 'remainingQuantity'>) =>
  initialOf(spool) > 0 ? Math.max(0, Math.min(100, Math.round((remainingOf(spool) / initialOf(spool)) * 100))) : 0;
export const spoolRemainingText = (spool: Pick<FilamentSpool, 'initialNetWeightG' | 'remainingQuantity'>) =>
  `${formatGrams(remainingOf(spool))} of ${formatGrams(initialOf(spool))}`;

/** Below this share of the initial net weight a spool counts as almost empty (as the API's `remainder_low`). */
export const LOW_PERCENT = 10;

/** "612 g of 1,000 g" over a thin bar, as in the spool tables. */
export function SpoolRemaining({ spool }: { spool: Pick<FilamentSpool, 'initialNetWeightG' | 'remainingQuantity'> }) {
  const percent = spoolPercent(spool);
  return (
    <div className="inv-remaining">
      <span>
        {formatGrams(remainingOf(spool))} <span className="mj-secondary">of {formatGrams(initialOf(spool))}</span>
      </span>
      <ProgressBar
        label={`${percent} % left`}
        hideLabel
        size="small"
        value={Math.min(remainingOf(spool), initialOf(spool))}
        max={Math.max(initialOf(spool), 1)}
        status={percent < LOW_PERCENT ? 'error' : 'active'}
      />
    </div>
  );
}

// Labels ------------------------------------------------------------------------

/** The short name of an article in a panel head: "PLA Basic" for filament, the name for parts. */
export const articleShortName = (
  material: Pick<Material, 'kind' | 'name' | 'materialTypeName' | 'variant'> | undefined,
) =>
  !material
    ? ''
    : material.kind === 'part'
      ? material.name
      : [material.materialTypeName, material.variant].filter(Boolean).join(' ') || material.name;

/**
 * The label prefix new spools of an article get: `S-<TYPECODE>-<VARIANT>-<COLOUR>`, upper case, missing parts left
 * out. The number is assigned by the server (the smallest free one among active spools).
 */
export const spoolLabelPrefix = (material: Pick<Material, 'materialTypeCode' | 'variant' | 'colorName'>) =>
  ['S', material.materialTypeCode, material.variant, material.colorName]
    .map((part) => part?.trim().toUpperCase())
    .filter(Boolean)
    .join('-');

// Identifiers -------------------------------------------------------------------

export const identifierKinds: { id: FilamentSpoolIdentifierKind; label: string }[] = [
  { id: 'nfc', label: 'NFC tag' },
  { id: 'barcode', label: 'Barcode' },
  { id: 'qr', label: 'QR code' },
];
export const identifierLabel = (kind: FilamentSpoolIdentifierKind) =>
  identifierKinds.find((item) => item.id === kind)?.label ?? kind;
/** Case-insensitive identity of an identifier, used to spot duplicates. */
export const identifierKey = (kind: string, value: string) => `${kind}:${value.trim().toLowerCase()}`;
/** The RFID (NFC) tag printers read, if the spool has one. */
export const nfcTagOf = (spool: Pick<FilamentSpool, 'identifiers'>) =>
  spool.identifiers.find((item) => item.kind === 'nfc')?.value ?? null;
