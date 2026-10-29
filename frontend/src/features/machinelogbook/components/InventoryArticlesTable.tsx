import type { ReactNode } from 'react';
import { Button, Link as CarbonLink } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { Material } from '../../../api/generated/models';
import { allMaterialsQuery, materialTypesQuery } from '../inventoryQueries';
import { processOptions } from '../processConfig';
import { DirectoryTable, useUrlState, type Column, type Option } from '../shared/DirectoryTable';
import { formatMoney } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { QueryBoundary } from '../shared/QueryBoundary';
import { ArticleKindTag, formatQuantity, isFilament, kindNames, StockTag, stockStateOptions } from './inventoryShared';

/** Materials are filament and consumables together; parts have their own table. */
export type ArticleScope = 'materials' | 'parts';

const uniqueOptions = (labels: (string | null | undefined)[]): Option[] =>
  [...new Set(labels.filter((label): label is string => Boolean(label)))]
    .sort((a, b) => a.localeCompare(b))
    .map((label) => ({ id: label, label }));

const column = (key: string, header: string, value: (row: Material) => string, narrow = true): Column<Material> => ({
  key,
  header,
  narrow,
  sortValue: value,
  render: (row) => value(row) || '—',
});

const colour: Column<Material> = {
  key: 'colour',
  header: 'Colour',
  sortValue: (row) => row.colorName ?? row.name,
  render: (row) => (
    <div className="mj-cell-stack">
      <span className="mj-inline">
        {row.colorHex && (
          <span
            className="mj-swatch"
            style={{ backgroundColor: row.colorHex }}
            role="img"
            aria-label={`Colour ${row.colorHex}`}
          />
        )}
        <CarbonLink as={Link} to={machineLogbookPaths.material(row.id)}>
          {row.colorName || row.name}
        </CarbonLink>
      </span>
      {!row.active && <span className="mj-secondary">Inactive</span>}
      <span className="mj-secondary mj-show-narrow">
        {[row.materialTypeName, row.variant, row.manufacturer].filter(Boolean).join(' · ')}
      </span>
    </div>
  ),
};
const kindColumn: Column<Material> = {
  key: 'kind',
  header: 'Kind',
  narrow: true,
  sortValue: (row) => row.kind,
  render: (row) => <ArticleKindTag kind={row.kind} />,
};
const stockColumns: Column<Material>[] = [
  {
    key: 'quantity',
    header: 'Stock',
    sortValue: (row) => Number(row.quantity),
    firstDirection: 'DESC',
    render: (row) => formatQuantity(row.quantity, row.unit),
  },
];
const location = column('location', 'Location', (row) => row.storageLocation ?? '');
const state: Column<Material> = {
  key: 'state',
  header: 'State',
  sortValue: (row) => row.stockState,
  render: (row) => <StockTag state={row.stockState} size="sm" />,
};

/** Loose stock and stock on spools only exist for filament. */
const spoolColumn = (key: string, header: string, pick: (row: Material) => string): Column<Material> => ({
  key,
  header,
  narrow: true,
  sortValue: (row) => (isFilament(row) ? Number(pick(row)) : -1),
  firstDirection: 'DESC',
  render: (row) => (isFilament(row) ? formatQuantity(pick(row), row.unit) : '—'),
});

const materialColumns: Column<Material>[] = [
  colour,
  kindColumn,
  column('type', 'Material', (row) => row.materialTypeName),
  column('variant', 'Variant', (row) => row.variant ?? ''),
  column('manufacturer', 'Manufacturer', (row) => row.manufacturer ?? ''),
  ...stockColumns,
  spoolColumn('loose', 'Loose stock', (row) => row.unassignedQuantity),
  spoolColumn('spools', 'On spools', (row) => row.assignedQuantity),
  location,
  state,
];
const partColumns: Column<Material>[] = [
  {
    key: 'name',
    header: 'Name',
    sortValue: (row) => row.name,
    render: (row) => (
      <div className="mj-cell-stack">
        <CarbonLink as={Link} to={machineLogbookPaths.material(row.id)}>
          {row.name}
        </CarbonLink>
        {!row.active && <span className="mj-secondary">Inactive</span>}
      </div>
    ),
  },
  column('type', 'Category', (row) => row.materialTypeName),
  ...stockColumns,
  {
    key: 'price',
    header: 'Sale price',
    narrow: true,
    sortValue: (row) => Number(row.salePrice ?? -1),
    firstDirection: 'DESC',
    render: (row) => (row.salePrice != null ? formatMoney(row.salePrice) : '—'),
  },
  location,
  state,
];

function ArticlesTable({
  scope,
  articles,
  canManage,
  onReceive,
  switcher,
}: {
  scope: ArticleScope;
  articles: Material[];
  canManage: boolean;
  onReceive: () => void;
  switcher: ReactNode;
}) {
  const navigate = useNavigate();
  const parts = scope === 'parts';
  // Plain parameters (q, stock, type, ...) so a link can name a filter without knowing the tab.
  const url = useUrlState('');
  const typeIds = url.list('type');
  const variantIds = url.list('variant');
  const manufacturerIds = url.list('manufacturer');
  const processIds = url.list('process');
  const stockIds = url.list('stock');
  const showInactive = url.get('inactive') === '1';
  const types = useQuery({ ...materialTypesQuery(), enabled: !parts });
  const processesOf = new Map((types.data ?? []).map((type) => [type.id, type.processes as string[]]));

  const inScope = articles.filter((article) => (article.kind === 'part') === parts);
  const rows = inScope.filter(
    (row) =>
      (showInactive || row.active) &&
      (typeIds.length === 0 || typeIds.includes(row.materialTypeId)) &&
      (variantIds.length === 0 || variantIds.includes(row.variant ?? '')) &&
      (manufacturerIds.length === 0 || manufacturerIds.includes(row.manufacturer ?? '')) &&
      (processIds.length === 0 ||
        processIds.some((process) => (processesOf.get(row.materialTypeId) ?? []).includes(process))) &&
      (stockIds.length === 0 || stockIds.includes(row.stockState)),
  );
  const typeOptions: Option[] = [...new Map(inScope.map((row) => [row.materialTypeId, row.materialTypeName])).entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const noun = parts ? 'parts' : 'materials';

  return (
    <DirectoryTable
      switcher={switcher}
      id={scope}
      urlPrefix=""
      label={parts ? 'Parts' : 'Materials'}
      columns={parts ? partColumns : materialColumns}
      rows={rows}
      totalCount={inScope.length}
      searchText={(row) =>
        [
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
      defaultSort={{ key: parts ? 'name' : 'colour', direction: 'ASC' }}
      onRowClick={(row) => navigate(machineLogbookPaths.material(row.id))}
      filterCategories={[
        { key: 'type', label: parts ? 'Category' : 'Material type', options: typeOptions },
        ...(parts ? [] : [{ key: 'variant', label: 'Variant', options: uniqueOptions(inScope.map((r) => r.variant)) }]),
        { key: 'manufacturer', label: 'Manufacturer', options: uniqueOptions(inScope.map((r) => r.manufacturer)) },
        ...(parts
          ? []
          : [{ key: 'process', label: 'Process', options: processOptions.map(({ id, label }) => ({ id, label })) }]),
        { key: 'stock', label: 'Stock state', options: stockStateOptions },
        { key: 'inactive', label: 'Show', options: [{ id: '1', label: 'Inactive articles' }] },
      ]}
      empty={{
        title: `No ${noun} yet`,
        description: `Receive stock to add ${noun} to the inventory. Quantities and costs are tracked from there.`,
        action: canManage ? (
          <Button kind="tertiary" onClick={onReceive}>
            Receive stock
          </Button>
        ) : undefined,
      }}
    />
  );
}

export function InventoryArticlesTable(props: Omit<Parameters<typeof ArticlesTable>[0], 'articles'>) {
  const query = useQuery(allMaterialsQuery());
  return (
    <QueryBoundary query={query} errorMessage="The inventory could not be loaded.">
      {(data) => <ArticlesTable {...props} articles={data.items} />}
    </QueryBoundary>
  );
}
