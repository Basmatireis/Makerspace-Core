/* eslint-disable react-refresh/only-export-components -- the ledger tables and their entry texts belong together */
import { type ReactNode } from 'react';
import { Button } from '@carbon/react';
import { TrashCan } from '@carbon/icons-react';
import { RefLink } from '../../../app/RefLink';
import type { InventoryTransaction, MaterialUnit } from '../../../api/generated/models';
import { DirectoryTable, useUrlState, type Column } from '../shared/DirectoryTable';
import { formatDateTime, formatMoney } from '../shared/format';
import {
  adjustmentReasonLabels,
  formatQuantity,
  formatSigned,
  formatSignedMoney,
  TransactionKindTag,
  transactionKindOptions,
} from './inventoryShared';

type SpoolRef = { id: string | null | undefined; displayId: string | null | undefined };

/** A spool as text: the label, or "S-… (deleted)" when the spool no longer exists (the entry keeps the label). */
const spoolText = ({ id, displayId }: SpoolRef) => (displayId ? (id ? displayId : `${displayId} (deleted)`) : null);
const own = (tx: InventoryTransaction): SpoolRef => ({ id: tx.spoolId, displayId: tx.spoolDisplayId });
const from = (tx: InventoryTransaction): SpoolRef => ({ id: tx.fromSpoolId, displayId: tx.fromSpoolDisplayId });
const to = (tx: InventoryTransaction): SpoolRef => ({ id: tx.toSpoolId, displayId: tx.toSpoolDisplayId });

export const transactionKindLabel = (tx: Pick<InventoryTransaction, 'kind'>) =>
  transactionKindOptions.find((item) => item.id === tx.kind)?.label ?? tx.kind;

/** Reason and note of an entry. */
export const ledgerNote = (tx: InventoryTransaction) =>
  [
    tx.adjustmentReason && tx.adjustmentReason !== 'mark_empty' ? adjustmentReasonLabels[tx.adjustmentReason] : null,
    tx.note,
  ]
    .filter(Boolean)
    .join(' · ');

/** One line saying what an entry refers to: job, order, spool, supplier and reference, or the price paid. */
export const ledgerReferenceText = (tx: InventoryTransaction) =>
  [
    tx.machineJobDisplayId,
    tx.orderReference,
    tx.kind === 'spool_transfer'
      ? [spoolText(from(tx)) ?? 'Loose stock', spoolText(to(tx)) ?? 'loose stock'].join(' → ')
      : spoolText(own(tx)),
    tx.kind === 'purchase' && tx.totalPurchasePrice != null ? formatMoney(tx.totalPurchasePrice) : null,
    tx.supplier,
    tx.reference,
  ]
    .filter(Boolean)
    .join(' · ');

/** The signed quantity of an entry; a transfer only moves attribution, so it shows the moved amount. */
export const ledgerQuantityText = (tx: InventoryTransaction, unit: MaterialUnit) =>
  tx.kind === 'spool_transfer' ? formatQuantity(tx.transferQuantity ?? 0, unit) : formatSigned(tx.quantityDelta, unit);

/** Ledger of stock movements for one article or one spool, shown as a Directory-style table. */
export function InventoryLedgerTable({
  id,
  transactions,
  unit,
  showSpool,
  onDelete,
}: {
  id: string;
  transactions: InventoryTransaction[];
  unit: MaterialUnit;
  showSpool: boolean;
  /** Offers Delete entry per row; pass it only with `inventory.ledger.delete`. */
  onDelete?: (transaction: InventoryTransaction) => void;
}) {
  const url = useUrlState(id);
  const typeIds = url.list('type');
  const spoolTexts = (tx: InventoryTransaction) => [own(tx), from(tx), to(tx)].map(spoolText).filter(Boolean);
  const rows = transactions.filter((tx) => typeIds.length === 0 || typeIds.includes(tx.kind));

  const spoolLink = (key: string, ref: SpoolRef) => {
    const text = spoolText(ref);
    if (!text) return null;
    return (
      <span key={key}>
        <RefLink kind="spool" reference={ref.displayId ?? ''} id={ref.id}>
          {text}
        </RefLink>
      </span>
    );
  };

  const reference = (tx: InventoryTransaction) => {
    const parts: ReactNode[] = [
      tx.machineJobDisplayId && (
        <span key="job">
          <RefLink kind="job" reference={tx.machineJobDisplayId} id={tx.machineJobId} />
        </span>
      ),
      tx.orderReference && (
        <span key="order">
          <RefLink kind="order" reference={tx.orderReference} id={tx.orderId} />
        </span>
      ),
      ...(showSpool
        ? tx.kind === 'spool_transfer'
          ? [spoolLink('from', from(tx)), spoolLink('to', to(tx))]
          : [spoolLink('spool', own(tx))]
        : []),
      tx.supplier && <span key="supplier">{tx.supplier}</span>,
      tx.reference && <span key="reference">{tx.reference}</span>,
    ].filter(Boolean);
    return parts.length ? <div className="mj-cell-stack">{parts}</div> : '—';
  };

  const columns: Column<InventoryTransaction>[] = [
    {
      key: 'date',
      header: 'Date',
      sortValue: (tx) => tx.occurredAt,
      firstDirection: 'DESC',
      render: (tx) => (
        <div className="mj-cell-stack">
          <span>{formatDateTime(tx.occurredAt)}</span>
          {tx.actorName && <span className="mj-secondary">{tx.actorName}</span>}
          {ledgerNote(tx) && <span className="mj-secondary mj-show-narrow">{ledgerNote(tx)}</span>}
        </div>
      ),
    },
    { key: 'type', header: 'Type', sortValue: (tx) => tx.kind, render: (tx) => <TransactionKindTag kind={tx.kind} /> },
    {
      key: 'quantity',
      header: 'Quantity',
      sortValue: (tx) => Number(tx.kind === 'spool_transfer' ? (tx.transferQuantity ?? 0) : tx.quantityDelta),
      firstDirection: 'DESC',
      render: (tx) => {
        if (tx.kind !== 'spool_transfer') return formatSigned(tx.quantityDelta, unit);
        // Transfers only move attribution between loose stock and a spool; the article total does not change.
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
    {
      key: 'value',
      header: 'Value',
      narrow: true,
      sortValue: (tx) => Number(tx.inventoryValueDelta),
      firstDirection: 'DESC',
      render: (tx) => (tx.kind === 'spool_transfer' ? '—' : formatSignedMoney(tx.inventoryValueDelta)),
    },
    { key: 'reference', header: 'Reference', narrow: true, render: reference },
    { key: 'note', header: 'Note', narrow: true, render: (tx) => ledgerNote(tx) || '—' },
    ...(onDelete
      ? [
          {
            key: 'actions',
            header: 'Actions',
            hiddenHeader: true,
            className: 'inv-actions-column',
            render: (tx: InventoryTransaction) => (
              <Button
                hasIconOnly
                kind="ghost"
                size="sm"
                renderIcon={TrashCan}
                iconDescription={`Delete ${transactionKindLabel(tx).toLowerCase()} of ${formatDateTime(tx.occurredAt)}`}
                onClick={() => onDelete(tx)}
              />
            ),
          } satisfies Column<InventoryTransaction>,
        ]
      : []),
  ];

  return (
    <DirectoryTable
      id={id}
      label="Ledger"
      columns={columns}
      rows={rows}
      totalCount={transactions.length}
      searchText={(tx) =>
        [
          tx.actorName,
          transactionKindLabel(tx),
          ledgerNote(tx),
          tx.supplier,
          tx.reference,
          tx.machineJobDisplayId,
          tx.orderReference,
          ...spoolTexts(tx),
        ]
          .filter(Boolean)
          .join(' ')
      }
      defaultSort={{ key: 'date', direction: 'DESC' }}
      filterCategories={[{ key: 'type', label: 'Type', options: transactionKindOptions }]}
      empty={{
        title: 'No movements yet',
        description: 'Purchases, sales, consumption, corrections and disposals appear here.',
      }}
    />
  );
}
