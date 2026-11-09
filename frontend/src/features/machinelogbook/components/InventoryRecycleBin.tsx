import { useState, type ReactNode } from 'react';
import { Button, Link as CarbonLink, Stack } from '@carbon/react';
import { Restart, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { DeletedInventoryTransaction, DeletedMaterial, FilamentSpool } from '../../../api/generated/models';
import { BinActionDialog, binEntryName, type BinEntry } from '../dialogs/BinDialogs';
import { inventoryRecycleBinQuery } from '../inventoryQueries';
import { DirectoryTable, type Column } from '../shared/DirectoryTable';
import { formatDateTime } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { QueryBoundary } from '../shared/QueryBoundary';
import { useCan } from '../shared/useCan';
import { ColorSwatch, formatQuantity, kindNames } from './inventoryShared';
import { ledgerQuantityText, ledgerReferenceText, transactionKindLabel } from './InventoryLedgerTable';
import { retireOutcomeText } from './spoolShared';

type Pending = { mode: 'restore' | 'purge'; entry: BinEntry };

const removedCell = (when: string | null, who: string | null) => (
  <div className="mj-cell-stack">
    <span>{when ? formatDateTime(when) : '—'}</span>
    <span className="mj-secondary">{who ? `by ${who}` : 'by a removed account'}</span>
  </div>
);

/** What the person may do with each kind of bin entry; the backend enforces the same permissions. */
function useBinPermissions() {
  const can = useCan();
  const spools = can('filament_spools.manage');
  return {
    material: { restore: can('inventory.delete'), purge: can('inventory.delete') },
    spool: { restore: spools && can('inventory.correct'), purge: spools && can('inventory.delete') },
    ledger: { restore: can('inventory.ledger.delete'), purge: can('inventory.ledger.delete') },
  };
}

function BinTables({
  materials,
  spools,
  ledgerEntries,
  switcher,
}: {
  materials: DeletedMaterial[];
  spools: FilamentSpool[];
  ledgerEntries: DeletedInventoryTransaction[];
  switcher?: ReactNode;
}) {
  const allowed = useBinPermissions();
  const [pending, setPending] = useState<Pending | null>(null);

  const actions = (entry: BinEntry, rights: { restore: boolean; purge: boolean }) =>
    rights.restore || rights.purge ? (
      <div className="inv-row-actions">
        {rights.restore && (
          <Button
            kind="ghost"
            size="sm"
            renderIcon={Restart}
            aria-label={`Restore ${binEntryName(entry)}`}
            onClick={() => setPending({ mode: 'restore', entry })}
          >
            Restore
          </Button>
        )}
        {rights.purge && (
          <Button
            hasIconOnly
            kind="ghost"
            size="sm"
            renderIcon={TrashCan}
            iconDescription={`Delete ${binEntryName(entry)} permanently`}
            onClick={() => setPending({ mode: 'purge', entry })}
          />
        )}
      </div>
    ) : null;
  const actionColumn = <T,>(
    entryOf: (row: T) => BinEntry,
    rights: { restore: boolean; purge: boolean },
  ): Column<T>[] =>
    rights.restore || rights.purge
      ? [
          {
            key: 'actions',
            header: 'Actions',
            hiddenHeader: true,
            className: 'inv-actions-column',
            render: (row) => actions(entryOf(row), rights),
          },
        ]
      : [];

  const materialColumns: Column<DeletedMaterial>[] = [
    {
      key: 'name',
      header: 'Article',
      sortValue: (row) => row.name,
      render: (row) => (
        <div className="mj-cell-stack">
          <span>{row.name}</span>
          <span className="mj-secondary">
            {row.displayId} · {row.materialTypeName}
          </span>
        </div>
      ),
    },
    { key: 'kind', header: 'Kind', narrow: true, sortValue: (row) => row.kind, render: (row) => kindNames[row.kind] },
    {
      key: 'stock',
      header: 'Stock',
      sortValue: (row) => Number(row.quantity),
      render: (row) => (
        <div className="mj-cell-stack">
          <span>{formatQuantity(row.quantity, row.unit)}</span>
          {row.spoolCount > 0 && (
            <span className="mj-secondary">
              {row.spoolCount} {row.spoolCount === 1 ? 'spool' : 'spools'}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'deleted',
      header: 'Deleted',
      sortValue: (row) => row.deletedAt,
      firstDirection: 'DESC',
      render: (row) => removedCell(row.deletedAt, row.deletedByName),
    },
    ...actionColumn<DeletedMaterial>((item) => ({ kind: 'material', item }), allowed.material),
  ];

  const spoolColumns: Column<FilamentSpool>[] = [
    {
      key: 'spool',
      header: 'Spool',
      sortValue: (row) => row.displayId,
      render: (row) => (
        <CarbonLink as={Link} to={machineLogbookPaths.spool(row.id)} className="inv-mono">
          {row.displayId}
        </CarbonLink>
      ),
    },
    {
      key: 'article',
      header: 'Article',
      narrow: true,
      sortValue: (row) => row.materialName,
      render: (row) => (
        <span className="inv-name">
          <ColorSwatch hex={row.colorHex} name={row.colorName} />
          {row.materialName}
        </span>
      ),
    },
    {
      key: 'outcome',
      header: 'What happened',
      render: (row) => retireOutcomeText(row) ?? 'Retired',
    },
    {
      key: 'retired',
      header: 'Retired',
      sortValue: (row) => row.archivedAt ?? '',
      firstDirection: 'DESC',
      render: (row) => removedCell(row.archivedAt, row.retiredByName),
    },
    ...actionColumn<FilamentSpool>((item) => ({ kind: 'spool', item }), allowed.spool),
  ];

  const ledgerColumns: Column<DeletedInventoryTransaction>[] = [
    {
      key: 'entry',
      header: 'Entry',
      sortValue: (row) => transactionKindLabel(row.transaction),
      render: (row) => (
        <div className="mj-cell-stack">
          <span>
            {transactionKindLabel(row.transaction)} · {ledgerQuantityText(row.transaction, row.unit)}
          </span>
          <span className="mj-secondary">
            {[formatDateTime(row.transaction.occurredAt), ledgerReferenceText(row.transaction)]
              .filter(Boolean)
              .join(' · ')}
          </span>
        </div>
      ),
    },
    {
      key: 'article',
      header: 'Article',
      narrow: true,
      sortValue: (row) => row.materialName,
      render: (row) => (
        <div className="mj-cell-stack">
          <CarbonLink as={Link} to={machineLogbookPaths.material(row.transaction.materialId)}>
            {row.materialName}
          </CarbonLink>
          <span className="mj-secondary">{row.materialDisplayId}</span>
        </div>
      ),
    },
    {
      key: 'deleted',
      header: 'Deleted',
      sortValue: (row) => row.deletedAt,
      firstDirection: 'DESC',
      render: (row) => removedCell(row.deletedAt, row.deletedByName),
    },
    ...actionColumn<DeletedInventoryTransaction>((item) => ({ kind: 'ledger', item }), allowed.ledger),
  ];

  const ledgerRows = ledgerEntries.map((entry) => ({ ...entry, id: entry.transaction.id }));

  return (
    <Stack gap={7}>
      <p className="inv-bin-intro">
        Deleted articles, retired spools and deleted ledger entries stay here. Restore an entry if it went here by
        mistake; deleting it permanently cannot be undone. Deleted jobs and runs are in the{' '}
        <CarbonLink as={Link} to={machineLogbookPaths.recycleBin()} inline>
          jobs recycle bin
        </CarbonLink>
        .
      </p>
      <section aria-labelledby="inv-bin-articles" className="mj-stack">
        <h2 id="inv-bin-articles" className="inv-section-title">
          Articles <span className="inv-count">{materials.length}</span>
        </h2>
        <DirectoryTable
          id="bin-articles"
          label="Deleted articles"
          switcher={switcher}
          columns={materialColumns}
          rows={materials}
          totalCount={materials.length}
          searchText={(row) => `${row.displayId} ${row.name} ${row.materialTypeName}`}
          defaultSort={{ key: 'deleted', direction: 'DESC' }}
          empty={{ title: 'No deleted articles', description: 'Articles you delete appear here.' }}
        />
      </section>
      <section aria-labelledby="inv-bin-spools" className="mj-stack">
        <h2 id="inv-bin-spools" className="inv-section-title">
          Spools <span className="inv-count">{spools.length}</span>
        </h2>
        <DirectoryTable
          id="bin-spools"
          label="Retired spools"
          columns={spoolColumns}
          rows={spools}
          totalCount={spools.length}
          searchText={(row) => `${row.displayId} ${row.materialName} ${row.materialDisplayId}`}
          defaultSort={{ key: 'retired', direction: 'DESC' }}
          empty={{ title: 'No retired spools', description: 'Spools you retire appear here.' }}
        />
      </section>
      <section aria-labelledby="inv-bin-ledger" className="mj-stack">
        <h2 id="inv-bin-ledger" className="inv-section-title">
          Ledger entries <span className="inv-count">{ledgerEntries.length}</span>
        </h2>
        <DirectoryTable
          id="bin-ledger"
          label="Deleted ledger entries"
          columns={ledgerColumns}
          rows={ledgerRows}
          totalCount={ledgerRows.length}
          searchText={(row) =>
            `${transactionKindLabel(row.transaction)} ${row.materialName} ${row.materialDisplayId} ${ledgerReferenceText(row.transaction)}`
          }
          defaultSort={{ key: 'deleted', direction: 'DESC' }}
          empty={{ title: 'No deleted ledger entries', description: 'Ledger entries you delete appear here.' }}
        />
      </section>
      {pending && <BinActionDialog mode={pending.mode} entry={pending.entry} onClose={() => setPending(null)} />}
    </Stack>
  );
}

/** The Recycle bin tab of the Inventory page. */
export function InventoryRecycleBin({ switcher }: { switcher?: ReactNode } = {}) {
  const query = useQuery(inventoryRecycleBinQuery());
  return (
    <QueryBoundary query={query} errorMessage="The recycle bin could not be loaded.">
      {(bin) => (
        <BinTables
          materials={bin.materials}
          spools={bin.spools}
          ledgerEntries={bin.ledgerEntries}
          switcher={switcher}
        />
      )}
    </QueryBoundary>
  );
}
