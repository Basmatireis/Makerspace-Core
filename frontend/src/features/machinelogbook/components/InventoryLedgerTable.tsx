import { useMemo, type ReactNode } from 'react';
import { RefLink } from '../../../app/RefLink';
import type { InventoryTransaction, MaterialUnit } from '../../../api/generated/models';
import { DirectoryTable, useUrlState, type Column } from '../shared/DirectoryTable';
import { formatDateTime } from '../shared/format';
import { adjustmentReasonLabels, formatQuantity, formatSigned, formatSignedMoney, TransactionKindTag, transactionKindOptions } from './inventoryShared';

type SpoolRef = { id: string | null | undefined; displayId: string | null | undefined; fillNumber: number | null | undefined };

/** A spool as text: the display ID, or "S-… (deleted)" when the spool no longer exists (the entry keeps the ID as a snapshot). */
const spoolText = ({ id, displayId }: SpoolRef) => displayId ? (id ? displayId : `${displayId} (deleted)`) : null;

/** Ledger of stock movements for one material or one spool, shown as a Directory-style table. */
export function InventoryLedgerTable({ id, transactions, unit, showSpool, showFill = false, materialNames }: {
  id: string; transactions: InventoryTransaction[]; unit: MaterialUnit; showSpool: boolean;
  /** Spool page: the ledger spans several fills, so each row names its fill and material. */
  showFill?: boolean;
  /** Material names by ID, used by `showFill` rows. */
  materialNames?: ReadonlyMap<string, string>;
}) {
  const url = useUrlState(id);
  const typeIds = url.list('type');
  const own = (tx: InventoryTransaction): SpoolRef => ({ id: tx.spoolId, displayId: tx.spoolDisplayId, fillNumber: tx.fillNumber });
  const from = (tx: InventoryTransaction): SpoolRef => ({ id: tx.fromSpoolId, displayId: tx.fromSpoolDisplayId, fillNumber: tx.fromFillNumber });
  const to = (tx: InventoryTransaction): SpoolRef => ({ id: tx.toSpoolId, displayId: tx.toSpoolDisplayId, fillNumber: tx.toFillNumber });
  const spoolTexts = (tx: InventoryTransaction) => [own(tx), from(tx), to(tx)].map(spoolText).filter(Boolean) as string[];

  const rows = useMemo(() => transactions.filter((tx) => typeIds.length === 0 || typeIds.includes(tx.kind)), [transactions, typeIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const spoolLink = (key: string, ref: SpoolRef) => {
    const text = spoolText(ref);
    if (!text) return null;
    const label = `${text}${ref.fillNumber ? ` · fill ${ref.fillNumber}` : ''}`;
    return <span key={key}><RefLink kind="spool" reference={ref.displayId ?? ''} id={ref.id}>{label}</RefLink></span>;
  };

  const reference = (tx: InventoryTransaction) => {
    const parts: ReactNode[] = [
      tx.machineJobDisplayId && <span key="job"><RefLink kind="job" reference={tx.machineJobDisplayId} id={tx.machineJobId} /></span>,
      tx.orderReference && <span key="order"><RefLink kind="order" reference={tx.orderReference} id={tx.orderId} /></span>,
      ...(showSpool ? (tx.kind === 'spool_transfer' ? [spoolLink('from', from(tx)), spoolLink('to', to(tx))] : [spoolLink('spool', own(tx))]) : []),
      showFill && tx.spoolDisplayId && tx.fillNumber && <span key="fill">Fill {tx.fillNumber} · {materialNames?.get(tx.materialId) ?? 'Material'}</span>,
      tx.supplier && <span key="supplier">{tx.supplier}</span>,
      tx.reference && <span key="reference">{tx.reference}</span>,
    ].filter(Boolean);
    return parts.length ? <div className="mj-cell-stack">{parts}</div> : '—';
  };

  const note = (tx: InventoryTransaction) => [tx.adjustmentReason && tx.adjustmentReason !== 'mark_empty' ? adjustmentReasonLabels[tx.adjustmentReason] : null, tx.note].filter(Boolean).join(' · ');

  const columns: Column<InventoryTransaction>[] = [
    {
      key: 'date', header: 'Date', sortValue: (tx) => tx.occurredAt, firstDirection: 'DESC',
      render: (tx) => (
        <div className="mj-cell-stack">
          <span>{formatDateTime(tx.occurredAt)}</span>
          {tx.actorName && <span className="mj-secondary">{tx.actorName}</span>}
          {note(tx) && <span className="mj-secondary mj-show-narrow">{note(tx)}</span>}
        </div>
      ),
    },
    { key: 'type', header: 'Type', sortValue: (tx) => tx.kind, render: (tx) => <TransactionKindTag kind={tx.kind} /> },
    {
      key: 'quantity', header: 'Quantity', sortValue: (tx) => Number(tx.kind === 'spool_transfer' ? tx.transferQuantity ?? 0 : tx.quantityDelta), firstDirection: 'DESC',
      render: (tx) => {
        if (tx.kind !== 'spool_transfer') return formatSigned(tx.quantityDelta, unit);
        // Transfers only move attribution between loose stock and a spool; the material total does not change.
        const amount = formatQuantity(tx.transferQuantity ?? 0, unit);
        const source = spoolText(from(tx));
        const target = spoolText(to(tx));
        return (
          <div className="mj-cell-stack">
            <span>{source ? `${amount}: ${source} → ${target ?? 'loose'}` : `${amount} → ${target ?? 'spool'}`}</span>
            <span className="mj-secondary">Total unchanged</span>
          </div>
        );
      },
    },
    { key: 'value', header: 'Value', narrow: true, sortValue: (tx) => Number(tx.inventoryValueDelta), firstDirection: 'DESC', render: (tx) => tx.kind === 'spool_transfer' ? '—' : formatSignedMoney(tx.inventoryValueDelta) },
    { key: 'reference', header: 'Reference', narrow: true, render: reference },
    { key: 'note', header: 'Note', narrow: true, render: (tx) => note(tx) || '—' },
  ];

  return (
    <DirectoryTable
      id={id} label="Ledger" columns={columns} rows={rows} totalCount={transactions.length}
      searchText={(tx) => [tx.actorName, tx.note, tx.supplier, tx.reference, tx.machineJobDisplayId, tx.orderReference, ...spoolTexts(tx)].filter(Boolean).join(' ')}
      defaultSort={{ key: 'date', direction: 'DESC' }}
      filterCategories={[{ key: 'type', label: 'Type', options: transactionKindOptions }]}
      empty={{ title: 'No movements yet', description: 'Purchases, sales, consumption, corrections and disposals appear here.' }}
    />
  );
}
