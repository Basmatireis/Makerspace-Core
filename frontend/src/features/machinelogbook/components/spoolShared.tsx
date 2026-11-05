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
  { id: 'bambu_tray_uuid', label: 'Bambu tray UUID' },
  { id: 'barcode', label: 'Barcode' },
  { id: 'qr', label: 'QR code' },
];
export const identifierLabel = (kind: FilamentSpoolIdentifierKind) =>
  identifierKinds.find((item) => item.id === kind)?.label ?? kind;
/** Case-insensitive identity of an identifier, used to spot duplicates. */
export const identifierKey = (kind: string, value: string) => `${kind}:${value.trim().toLowerCase()}`;
/** The identifier printers read from the spool, if it has one: the Bambu tray UUID, else the NFC chip UID. */
export const nfcTagOf = (spool: Pick<FilamentSpool, 'identifiers'>) =>
  (
    spool.identifiers.find((item) => item.kind === 'bambu_tray_uuid') ??
    spool.identifiers.find((item) => item.kind === 'nfc')
  )?.value ?? null;

/** What a printer reports about a spool's RFID tags. */
export type ReportedTag = { tagUid?: string | null; trayUuid?: string | null };
export type TrayIdentifier = { kind: 'bambu_tray_uuid' | 'nfc'; value: string };

/** The identifier to link a spool with: the tray UUID (shared by both chips of a Bambu spool) when reported, else the chip UID. */
export function trayIdentifier(tag: ReportedTag | null | undefined): TrayIdentifier | null {
  const uuid = tag?.trayUuid?.trim();
  if (uuid) return { kind: 'bambu_tray_uuid', value: uuid };
  const uid = tag?.tagUid?.trim();
  return uid ? { kind: 'nfc', value: uid } : null;
}

/** Label and value for showing the spool identity a printer reports. */
export function trayIdentityDisplay(tag: ReportedTag | null | undefined): { label: string; value: string } | null {
  const identifier = trayIdentifier(tag);
  if (!identifier) return null;
  return { label: identifier.kind === 'bambu_tray_uuid' ? 'Bambu spool' : 'RFID', value: identifier.value };
}

/** Whether an identifier the printer reports equals one on the spool: the tray UUID against bambu_tray_uuid first, then the chip UID against nfc, case-insensitively. */
export function spoolMatchesTag(spool: Pick<FilamentSpool, 'identifiers'>, tag: ReportedTag): boolean {
  const has = (kind: string, value: string | null | undefined) =>
    Boolean(value) &&
    spool.identifiers.some((item) => item.kind === kind && item.value.toLowerCase() === value!.toLowerCase());
  return has('bambu_tray_uuid', tag.trayUuid) || has('nfc', tag.tagUid);
}
