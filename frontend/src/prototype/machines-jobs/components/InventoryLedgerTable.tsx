import { useMemo, type ReactNode } from 'react';
import { Link as CarbonLink } from '@carbon/react';
import { Link } from 'react-router-dom';
import { formatDateTime } from '../derived';
import { useStore } from '../store';
import type { InventoryTransaction, MaterialUnit } from '../types';
import { LinkifiedText, RefLink } from './RefLink';
import { DirectoryTable, useUrlState, type Column } from './DirectoryTable';
import { formatQuantity, formatSigned, formatSignedMoney, TransactionKindTag, transactionKindOptions } from './inventoryShared';


/** Ledger of stock movements for one material or one spool, shown as a Directory-style table. */
export function InventoryLedgerTable({ id, transactions, unit, showSpool, showFill = false }: {
  id: string; transactions: InventoryTransaction[]; unit: MaterialUnit; showSpool: boolean;
  /** Spool page: the ledger spans several fills, so each row names its fill and material. */
  showFill?: boolean;
}) {
  const { jobs, spools, materials } = useStore();
  const url = useUrlState(id);
  const typeIds = url.list('type');
  const spoolExists = (tx: InventoryTransaction) => spools.some((spool) => spool.id === tx.spoolId);
  // A spool that was deleted stays visible as plain text: its ID is a snapshot on the entry.
  const spoolName = (tx: InventoryTransaction) => tx.spoolId ? (spoolExists(tx) ? spools.find((spool) => spool.id === tx.spoolId)?.displayId : tx.spoolDisplayId ? `${tx.spoolDisplayId} (deleted)` : null) ?? null : null;
  const jobName = (tx: InventoryTransaction) => jobs.find((job) => job.id === tx.jobId)?.displayId ?? null;

  const rows = useMemo(() => transactions.filter((tx) => typeIds.length === 0 || typeIds.includes(tx.kind)), [transactions, typeIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const reference = (tx: InventoryTransaction) => {
    const job = jobName(tx);
    const spool = showSpool ? spoolName(tx) : null;
    const parts: ReactNode[] = [
      tx.jobId && job && <RefLink key="job" reference={job} id={tx.jobId} />,
      spool && tx.spoolId && (spoolExists(tx)
        ? <CarbonLink key="spool" as={Link} to={`/inventory/spools/${tx.spoolId}`}>{spool}{tx.fillNumber ? ` · fill ${tx.fillNumber}` : ''}</CarbonLink>
        : <span key="spool">{spool}{tx.fillNumber ? ` · fill ${tx.fillNumber}` : ''}</span>),
      showFill && tx.spoolId && tx.fillNumber && <span key="fill">Fill {tx.fillNumber} · {materials.find((material) => material.id === tx.materialId)?.name ?? 'Material'}</span>,
      tx.supplier && <span key="supplier">{tx.supplier}</span>,
    ].filter(Boolean);
    return parts.length ? <div className="mj-cell-stack">{parts}</div> : '—';
  };

  const columns: Column<InventoryTransaction>[] = [
    {
      key: 'date', header: 'Date', sortValue: (tx) => tx.occurredAt, firstDirection: 'DESC',
      render: (tx) => (
        <div className="mj-cell-stack">
          <span>{formatDateTime(tx.occurredAt)}</span>
          <span className="mj-secondary">{tx.by}</span>
          {tx.note && <span className="mj-secondary mj-show-narrow"><LinkifiedText text={tx.note} /></span>}
        </div>
      ),
    },
    { key: 'type', header: 'Type', sortValue: (tx) => tx.kind, render: (tx) => <TransactionKindTag kind={tx.kind} /> },
    {
      key: 'quantity', header: 'Quantity', sortValue: (tx) => tx.quantity, firstDirection: 'DESC',
      render: (tx) => {
        if (tx.kind !== 'transfer') return formatSigned(tx.quantity, unit);
        // Transfers only move attribution between loose stock and a spool; the material total does not change.
        const spool = spoolName(tx) ?? tx.spoolDisplayId ?? 'spool';
        return (
          <div className="mj-cell-stack">
            <span>{tx.quantity >= 0 ? `${formatQuantity(tx.quantity, unit)} → ${spool}` : `${formatQuantity(-tx.quantity, unit)}: ${spool} → loose`}</span>
            <span className="mj-secondary">Total unchanged</span>
          </div>
        );
      },
    },
    { key: 'value', header: 'Value', narrow: true, sortValue: (tx) => tx.totalValue ?? 0, firstDirection: 'DESC', render: (tx) => formatSignedMoney(tx.totalValue) },
    { key: 'reference', header: 'Reference', narrow: true, render: reference },
    { key: 'note', header: 'Note', narrow: true, render: (tx) => tx.note ? <LinkifiedText text={tx.note} /> : '—' },
  ];

  return (
    <DirectoryTable
      id={id} label="Ledger" columns={columns} rows={rows} totalCount={transactions.length}
      searchText={(tx) => [tx.note, tx.supplier, tx.by, jobName(tx), spoolName(tx)].filter(Boolean).join(' ')}
      defaultSort={{ key: 'date', direction: 'DESC' }}
      filterCategories={[{ key: 'type', label: 'Type', options: transactionKindOptions }]}
      empty={{ title: 'No movements yet', description: 'Purchases, consumption, corrections and disposals appear here.' }}
    />
  );
}
