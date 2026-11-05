import { useState, type MouseEvent, type ReactNode } from 'react';
import { Button, Link as CarbonLink } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { FilamentSpool, Material } from '../../../api/generated/models';
import { ListWithPanel, useListPanelLayout } from '../../../app/components/ListWithPanel';
import { allMaterialsQuery, materialTypesQuery } from '../inventoryQueries';
import { processesQuery } from '../queries';
import {
  attentionDirectoryColumn,
  DirectoryTable,
  useUrlState,
  type Column,
  type Option,
} from '../shared/DirectoryTable';
import { machineLogbookPaths } from '../shared/paths';
import { QueryBoundary } from '../shared/QueryBoundary';
import { useCan } from '../shared/useCan';
import { allSpoolsQuery } from '../spoolData';
import { ArticleDialogs, useArticlePermissions, useSelectedRow, type ArticleDialog } from './articleActions';
import { ArticlePanel, EmptyPanel, stockHelper } from './ArticlePanel';
import { ColorSwatch, formatQuantity, kindNames, StockTag, stockStateOptions } from './inventoryShared';

const uniqueOptions = (labels: (string | null | undefined)[]): Option[] =>
  [...new Set(labels.filter((label): label is string => Boolean(label)))]
    .sort((a, b) => a.localeCompare(b))
    .map((label) => ({ id: label, label }));

function ArticlesTable({
  articles,
  spoolCounts,
  onReceive,
  switcher,
}: {
  articles: Material[];
  spoolCounts: ReadonlyMap<string, number> | undefined;
  onReceive: () => void;
  switcher?: ReactNode;
}) {
  const navigate = useNavigate();
  const can = useCan();
  const allowed = useArticlePermissions();
  const panelFits = useListPanelLayout();
  const [selected, select] = useSelectedRow();
  const [dialog, setDialog] = useState<ArticleDialog | null>(null);
  // Plain parameters (q, stock, type, ...) so a link can name a filter without knowing the tab.
  const url = useUrlState('');
  const typeIds = url.list('type');
  const manufacturerIds = url.list('manufacturer');
  const processIds = url.list('process');
  const stockIds = url.list('stock');
  const showInactive = url.get('inactive') === '1';
  const types = useQuery(materialTypesQuery());
  const processes = useQuery({ ...processesQuery(), enabled: can('machines.read') });
  const processOptions: Option[] = (processes.data?.items ?? []).map(({ id, name }) => ({ id, label: name }));
  const processesOf = new Map((types.data ?? []).map((type) => [type.id, type.processIds as string[]]));

  const inScope = articles;
  const rows = inScope.filter(
    (row) =>
      (showInactive || row.active) &&
      (typeIds.length === 0 || typeIds.includes(row.materialTypeId)) &&
      (manufacturerIds.length === 0 || manufacturerIds.includes(row.manufacturer ?? '')) &&
      (processIds.length === 0 ||
        processIds.some((process) => (processesOf.get(row.materialTypeId) ?? []).includes(process))) &&
      (stockIds.length === 0 || stockIds.includes(row.stockState)),
  );
  const typeOptions: Option[] = [...new Map(inScope.map((row) => [row.materialTypeId, row.materialTypeName])).entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const noun = 'articles';
  const current = selected ? articles.find((article) => article.id === selected) : undefined;

  // Wide screens select the row into the panel; below 1056 px the panel is gone, so the article page opens.
  const open = (row: Material) => (panelFits ? select(row.id) : navigate(machineLogbookPaths.material(row.id)));
  const onNameClick = (event: MouseEvent, row: Material) => {
    if (!panelFits || event.metaKey || event.ctrlKey || event.shiftKey) return;
    event.preventDefault();
    select(row.id);
  };

  const columns: Column<Material>[] = [
    {
      key: 'number',
      header: 'Article',
      narrow: true,
      sortValue: (row) => row.displayId,
      render: (row) => <span className="inv-mono">{row.displayId}</span>,
    },
    {
      key: 'type',
      header: 'Type',
      narrow: true,
      sortValue: (row) => `${row.materialTypeName}\u0000${row.name}`,
      render: (row) => row.materialTypeName,
    },
    {
      key: 'name',
      header: 'Name',
      sortValue: (row) => row.name,
      render: (row) => (
        <div className="mj-cell-stack">
          <span className="inv-name">
            <ColorSwatch hex={row.colorHex} name={row.colorName} />
            <CarbonLink
              as={Link}
              to={machineLogbookPaths.material(row.id)}
              className={row.id === selected && panelFits ? 'inv-row-selected' : undefined}
              aria-current={row.id === selected && panelFits ? 'true' : undefined}
              onClick={(event: MouseEvent) => onNameClick(event, row)}
            >
              {row.name}
            </CarbonLink>
          </span>
          {!row.active && <span className="mj-secondary">Inactive</span>}
          <span className="mj-secondary mj-show-narrow">
            {[row.displayId, row.materialTypeName, row.storageLocation].filter(Boolean).join(' · ')}
          </span>
        </div>
      ),
    },
    {
      key: 'manufacturer',
      header: 'Manufacturer',
      narrow: true,
      sortValue: (row) => row.manufacturer ?? '',
      render: (row) => row.manufacturer || '—',
    },
    {
      key: 'stock',
      header: 'Stock',
      sortValue: (row) => Number(row.quantity),
      firstDirection: 'DESC',
      render: (row) =>
        row.stockState === 'empty' ? (
          <StockTag state="empty" size="sm" />
        ) : (
          <div className="mj-cell-stack">
            <span>{formatQuantity(row.quantity, row.unit, row.countLabel)}</span>
            <span className="mj-secondary">
              {[
                stockHelper(row, spoolCounts?.get(row.id) ?? (spoolCounts ? 0 : undefined)),
                row.stockState === 'low_stock' ? 'low' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
        ),
    },
    {
      key: 'location',
      header: 'Location',
      narrow: true,
      sortValue: (row) => row.storageLocation ?? '',
      render: (row) => row.storageLocation || '—',
    },
    attentionDirectoryColumn<Material>((row) => row.attention),
  ];

  return (
    <ListWithPanel
      panelLabel="Article details"
      panel={
        current ? (
          <ArticlePanel material={current} onClose={() => select(null)} onAction={setDialog} />
        ) : (
          <EmptyPanel text="Select an article to see its stock, prices and ledger here." />
        )
      }
    >
      <DirectoryTable
        switcher={switcher}
        id="articles"
        urlPrefix=""
        label="Articles"
        columns={columns}
        rows={rows}
        totalCount={inScope.length}
        searchText={(row) =>
          [
            row.displayId,
            row.name,
            row.materialTypeName,
            kindNames[row.kind],
            row.variant,
            row.colorName,
            row.manufacturer,
            row.storageLocation,
            row.notes,
          ]
            .filter(Boolean)
            .join(' ')
        }
        defaultSort={{ key: 'type', direction: 'ASC' }}
        pageSizes={[25, 50, 100]}
        onRowClick={open}
        toolbarAction={
          allowed.manage ? (
            <Button renderIcon={Add} onClick={onReceive} data-guide="workshop-receive-stock">
              Receive stock
            </Button>
          ) : undefined
        }
        filterCategories={[
          { key: 'type', label: 'Type', options: typeOptions },
          { key: 'manufacturer', label: 'Manufacturer', options: uniqueOptions(inScope.map((r) => r.manufacturer)) },
          ...(processOptions.length === 0 ? [] : [{ key: 'process', label: 'Machine use', options: processOptions }]),
          { key: 'stock', label: 'Stock state', options: stockStateOptions },
          { key: 'inactive', label: 'Show', options: [{ id: '1', label: 'Inactive articles' }] },
        ]}
        empty={{
          title: `No ${noun} yet`,
          description: `Receive stock to add ${noun} to the inventory. Quantities and costs are tracked from there.`,
          action: allowed.manage ? (
            <Button kind="tertiary" onClick={onReceive}>
              Receive stock
            </Button>
          ) : undefined,
        }}
      />
      {current && (
        <ArticleDialogs
          material={current}
          dialog={dialog}
          onClose={() => setDialog(null)}
          onDeleted={() => select(null)}
        />
      )}
    </ListWithPanel>
  );
}

const countByMaterial = (spools: FilamentSpool[]) => {
  const counts = new Map<string, number>();
  for (const spool of spools) counts.set(spool.materialId, (counts.get(spool.materialId) ?? 0) + 1);
  return counts;
};

export function InventoryArticlesTable(props: { onReceive: () => void; switcher?: ReactNode }) {
  const query = useQuery(allMaterialsQuery());
  const spools = useQuery(allSpoolsQuery({ lifecycle: 'active' }));
  return (
    <QueryBoundary query={query} errorMessage="The inventory could not be loaded.">
      {(data) => (
        <ArticlesTable
          {...props}
          articles={data.items}
          spoolCounts={spools.data ? countByMaterial(spools.data) : undefined}
        />
      )}
    </QueryBoundary>
  );
}
