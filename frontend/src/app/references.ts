import { PermissionId, type PermissionIdType } from '../features/auth/permissions';
import { machineLogbookPaths } from '../features/machinelogbook/shared/paths';

/**
 * Entities with their own detail page and a generated reference: jobs (J-YYYY-NNNNNN), runs (R-…), orders (O-…),
 * payments (P-…) and filament spools (S-…).
 */
export type RefKind = 'job' | 'run' | 'order' | 'payment' | 'spool';

const SOURCE = String.raw`(?:[JROPS]-\d{4}-\d{6})`;
/** Matches one reference inside generated text. Use `splitRefs` instead of running it directly (it is not global). */
const SPLIT = new RegExp(`(?<![\\w-])(${SOURCE})(?![\\w-])`);

const prefixKind: Record<string, RefKind> = { J: 'job', R: 'run', O: 'order', P: 'payment', S: 'spool' };

export function refKind(reference: string): RefKind | null {
  return /^[JROPS]-/.test(reference) ? prefixKind[reference.charAt(0)] ?? null : null;
}

/** Read permission of the page a reference points to. Links to pages the person cannot open stay plain text. */
export const refPermission: Record<RefKind, PermissionIdType> = {
  job: PermissionId.machine_jobsread,
  run: PermissionId.machine_jobsread,
  order: PermissionId.ordersread,
  payment: PermissionId.paymentsread,
  spool: PermissionId.inventoryread,
};

export function refRoute(kind: RefKind, id: string): string {
  switch (kind) {
    case 'job': return machineLogbookPaths.job(id);
    case 'run': return machineLogbookPaths.run(id);
    case 'spool': return machineLogbookPaths.spool(id);
    case 'order': return `/orders/${encodeURIComponent(id)}`;
    default: return `/payments/${encodeURIComponent(id)}`;
  }
}

/** Splits generated text into plain parts (even indexes) and references (odd indexes). */
export function splitRefs(text: string): string[] {
  return text.split(SPLIT);
}
