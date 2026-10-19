import type { Permission } from './store';

/** Entities that have their own page and a generated reference: jobs (J-0000), runs (R-YYYY-NNNNNN), orders (O-YYYY-NNNNNN) and payments (P-YYYY-NNNNNN). */
export type RefKind = 'job' | 'run' | 'order' | 'payment';

const SOURCE = String.raw`(?:[ROP]-\d{4}-\d{6}|J-\d{4,})`;
/** Matches one reference inside generated text. Use `splitRefs` instead of running it directly (it is not global). */
const SPLIT = new RegExp(`(?<![\\w-])(${SOURCE})(?![\\w-])`);

const prefixKind: Record<string, RefKind> = { J: 'job', R: 'run', O: 'order', P: 'payment' };

export function refKind(reference: string): RefKind | null {
  return prefixKind[reference.charAt(0)] ?? null;
}

export const refPermission: Record<RefKind, Permission> = { job: 'machine_jobs.read', run: 'machine_jobs.read', order: 'orders.read', payment: 'payments.read' };

export function refRoute(kind: RefKind, id: string): string {
  return kind === 'job' ? `/jobs/${id}` : kind === 'run' ? `/jobs/runs/${id}` : kind === 'order' ? `/sales/orders/${id}` : `/sales/payments/${id}`;
}

/** Splits generated text into plain parts (even indexes) and references (odd indexes). */
export function splitRefs(text: string): string[] {
  return text.split(SPLIT);
}
