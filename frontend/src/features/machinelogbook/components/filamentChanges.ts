import { useEffect, useRef } from 'react';
import type { PrinterLiveStatusSnapshot, PrinterLiveStatusTray, PrinterProfile } from '../../../api/generated/models';
import type { Toast } from '../shared/toasts';

type Snapshot = PrinterLiveStatusSnapshot | null | undefined;

/** What identifies the material in a tray; the remaining percentage is left out because it changes all the time. */
function identity(tray: PrinterLiveStatusTray): string | null {
  if (tray.empty) return null;
  return [tray.tagUid ?? '', tray.rfid, tray.materialType ?? '', tray.subBrand ?? '', tray.colorHex ?? ''].join('|');
}

const hasTag = (tray: PrinterLiveStatusTray) => Boolean(tray.tagUid) || tray.rfid;
const materialOf = (tray: PrinterLiveStatusTray) => tray.subBrand || tray.materialType || 'unknown material';

/**
 * Toasts for trays whose content changed between two consecutive live snapshots of the same printer. Needs the
 * profile to tell whether a spool is mounted in the slot the tray maps to: a tray that is not mapped gets neutral
 * wording because nothing is known about its spool.
 */
export function filamentChangeToasts(previous: Snapshot, next: Snapshot, profile: PrinterProfile | undefined): Toast[] {
  if (!previous || !next) return [];
  const toasts: Toast[] = [];
  for (const unit of next.units) {
    const before = previous.units.find((candidate) => candidate.externalId === unit.externalId);
    if (!before) continue;
    const profileUnit = profile?.inputUnits.find((candidate) => candidate.externalIdentifier === unit.externalId);
    for (const tray of unit.trays) {
      const old = before.trays.find((candidate) => candidate.externalId === tray.externalId);
      if (!old || identity(old) === identity(tray)) continue;
      const slotName = `Slot ${unit.label} · ${tray.externalId}`;
      const slot = profileUnit
        ? profile?.slots.find(
            (candidate) =>
              candidate.inputUnitId === profileUnit.id &&
              candidate.externalIdentifier === tray.externalId &&
              candidate.status !== 'retired',
          )
        : undefined;
      let subtitle: string;
      let kind: Toast['kind'] = 'info';
      if (tray.empty) {
        subtitle = 'spool removed';
      } else if (!hasTag(tray)) {
        subtitle = 'material without RFID tag — assign a spool by hand';
        kind = 'warning';
      } else if (!slot) {
        subtitle = `material changed (${materialOf(tray)})`;
      } else if (slot.spoolId) {
        subtitle = `${materialOf(tray)} loaded`;
      } else {
        subtitle = `new material (${materialOf(tray)}) without a known spool`;
        kind = 'warning';
      }
      toasts.push({ kind, title: `${slotName}: ${subtitle}` });
    }
  }
  return toasts;
}

/** Calls `notify` for every tray change between consecutive snapshots; the first snapshot only sets the baseline. */
export function useFilamentChangeToasts(
  machineId: string,
  snapshot: Snapshot,
  profile: PrinterProfile | undefined,
  notify: (toast: Toast) => void,
): void {
  const previous = useRef<{ machineId: string; snapshot: Snapshot } | null>(null);
  // Read through a ref so a new profile object or notify identity does not re-run the comparison.
  const latest = useRef({ profile, notify });
  useEffect(() => {
    latest.current = { profile, notify };
  });
  useEffect(() => {
    if (!snapshot) return;
    const before = previous.current;
    previous.current = { machineId, snapshot };
    if (!before || before.machineId !== machineId || before.snapshot === snapshot) return;
    for (const toast of filamentChangeToasts(before.snapshot, snapshot, latest.current.profile)) {
      latest.current.notify(toast);
    }
  }, [machineId, snapshot]);
}
