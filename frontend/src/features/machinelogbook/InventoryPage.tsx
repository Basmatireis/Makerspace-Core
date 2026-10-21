import { useState, type ReactNode } from 'react';
import { Button, Link as CarbonLink, OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Material, MaterialKind } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { SectionSwitcher } from '../../app/SectionSwitcher';
import { InventorySpoolsTable } from './components/InventorySpoolsTable';
import { formatQuantity, NoInventoryAccess, StockTag, stockStateOptions } from './components/inventoryShared';
import { MaterialFormModal } from './dialogs/MaterialFormModal';
import { MaterialTypesModal } from './dialogs/MaterialTypesModal';
import { ReceiveStockModal } from './dialogs/ReceiveStockModal';
import { allMaterialsQuery, materialTypesQuery } from './inventoryQueries';
import { processOptions } from './processConfig';
import { DirectoryTable, useUrlState, type Column, type Option } from './shared/DirectoryTable';
import { formatMoney } from './shared/format';
import { machineLogbookPaths, type InventoryTab } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { useCan } from './shared/useCan';
import './styles/inventory.scss';

const TABS: InventoryTab[] = ['filament', 'consumables', 'parts', 'spools'];
const TAB_KIND: Record<Exclude<InventoryTab, 'spools'>, MaterialKind> = {
  filament: 'filament',
  consumables: 'consumable',
  parts: 'part',
};
const TAB_LABEL: Record<Exclude<InventoryTab, 'spools'>, string> = {
  filament: 'Filament',
  consumables: 'Consumables',
  parts: 'Parts',
};

const uniqueOptions = (labels: (string | null | undefined)[]): Option[] =>
  [...new Set(labels.filter((label): label is string => Boolean(label)))]
    .sort((a, b) => a.localeCompare(b))
    .map((label) => ({ id: label, label }));

function ArticlesTable({
  tab,
  articles,
  canManage,
  onReceive,
  switcher,
}: {
  tab: Exclude<InventoryTab, 'spools'>;
  articles: Material[];
  canManage: boolean;
  onReceive: () => void;
  switcher: ReactNode;
}) {
  const kind = TAB_KIND[tab];
  const navigate = useNavigate();
  // Plain parameters (q, stock, type, ...) so a link can name a filter without knowing the tab.
  const url = useUrlState('');
  const typeIds = url.list('type');
  const variantIds = url.list('variant');
  const manufacturerIds = url.list('manufacturer');
  const processIds = url.list('process');
  const stockIds = url.list('stock');
  const showInactive = url.get('inactive') === '1';
  const types = useQuery({ ...materialTypesQuery(), enabled: kind === 'consumable' });
  const processesOf = new Map((types.data ?? []).map((type) => [type.id, type.processes]));

  const ofKind = articles.filter((article) => article.kind === kind);
  const rows = ofKind.filter(
    (row) =>
      (showInactive || row.active) &&
      (typeIds.length === 0 || typeIds.includes(row.materialTypeId)) &&
      (variantIds.length === 0 || variantIds.includes(row.variant ?? '')) &&
      (manufacturerIds.length === 0 || manufacturerIds.includes(row.manufacturer ?? '')) &&
      (processIds.length === 0 ||
        processIds.some((process) => (processesOf.get(row.materialTypeId) ?? []).includes(process as never))) &&
      (stockIds.length === 0 || stockIds.includes(row.stockState)),
  );
  const typeOptions: Option[] = [...new Map(ofKind.map((row) => [row.materialTypeId, row.materialTypeName])).entries()]
    .map(([id, label]) => ({ id, label }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const nameCell = (row: Material, text: string) => (
    <div className="mj-cell-stack">
      <CarbonLink as={Link} to={machineLogbookPaths.material(row.id)}>
        {text}
      </CarbonLink>
      {!row.active && <span className="mj-secondary">Inactive</span>}
    </div>
  );
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
  const type: Column<Material> = {
    key: 'type',
    header: kind === 'part' ? 'Category' : 'Material',
    narrow: true,
    sortValue: (row) => row.materialTypeName,
    render: (row) => row.materialTypeName,
  };
  const variant: Column<Material> = {
    key: 'variant',
    header: 'Variant',
    narrow: true,
    sortValue: (row) => row.variant ?? '',
    render: (row) => row.variant || '—',
  };
  const manufacturer: Column<Material> = {
    key: 'manufacturer',
    header: 'Manufacturer',
    narrow: true,
    sortValue: (row) => row.manufacturer ?? '',
    render: (row) => row.manufacturer || '—',
  };
  const location: Column<Material> = {
    key: 'location',
    header: 'Location',
    narrow: true,
    sortValue: (row) => row.storageLocation ?? '',
    render: (row) => row.storageLocation || '—',
  };
  const state: Column<Material> = {
    key: 'state',
    header: 'State',
    sortValue: (row) => row.stockState,
    render: (row) => <StockTag state={row.stockState} size="sm" />,
  };
  const stock: Column<Material> = {
    key: 'quantity',
    header: 'Stock',
    sortValue: (row) => Number(row.quantity),
    firstDirection: 'DESC',
    render: (row) => formatQuantity(row.quantity, row.unit),
  };

  const columns: Column<Material>[] =
    kind === 'filament'
      ? [
          colour,
          type,
          variant,
          manufacturer,
          {
            key: 'loose',
            header: 'Loose stock',
            narrow: true,
            sortValue: (row) => Number(row.unassignedQuantity),
            firstDirection: 'DESC',
            render: (row) => formatQuantity(row.unassignedQuantity, row.unit),
          },
          {
            key: 'spools',
            header: 'On spools',
            narrow: true,
            sortValue: (row) => Number(row.assignedQuantity),
            firstDirection: 'DESC',
            render: (row) => formatQuantity(row.assignedQuantity, row.unit),
          },
          location,
          state,
        ]
      : kind === 'consumable'
        ? [colour, type, variant, manufacturer, stock, location, state]
        : [
            { key: 'name', header: 'Name', sortValue: (row) => row.name, render: (row) => nameCell(row, row.name) },
            type,
            stock,
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

  const noun = kind === 'filament' ? 'filament' : kind === 'consumable' ? 'consumables' : 'parts';
  return (
    <DirectoryTable
      switcher={switcher}
      id={tab}
      urlPrefix=""
      label={TAB_LABEL[tab]}
      columns={columns}
      rows={rows}
      totalCount={ofKind.length}
      searchText={(row) =>
        [row.name, row.materialTypeName, row.variant, row.colorName, row.manufacturer, row.storageLocation]
          .filter(Boolean)
          .join(' ')
      }
      defaultSort={{ key: kind === 'part' ? 'name' : 'colour', direction: 'ASC' }}
      onRowClick={(row) => navigate(machineLogbookPaths.material(row.id))}
      filterCategories={[
        { key: 'type', label: kind === 'part' ? 'Category' : 'Material type', options: typeOptions },
        ...(kind === 'part'
          ? []
          : [{ key: 'variant', label: 'Variant', options: uniqueOptions(ofKind.map((row) => row.variant)) }]),
        { key: 'manufacturer', label: 'Manufacturer', options: uniqueOptions(ofKind.map((row) => row.manufacturer)) },
        ...(kind === 'consumable'
          ? [
              {
                key: 'process',
                label: 'Process',
                options: processOptions
                  .filter((option) => option.id !== 'fdm_printing')
                  .map((option) => ({ id: option.id, label: option.label })),
              },
            ]
          : []),
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

function ArticlesTab({
  tab,
  canManage,
  onReceive,
  switcher,
}: {
  tab: Exclude<InventoryTab, 'spools'>;
  canManage: boolean;
  onReceive: () => void;
  switcher: ReactNode;
}) {
  const query = useQuery(allMaterialsQuery());
  return (
    <QueryBoundary query={query} errorMessage="The inventory could not be loaded.">
      {(data) => (
        <ArticlesTable
          tab={tab}
          articles={data.items}
          canManage={canManage}
          onReceive={onReceive}
          switcher={switcher}
        />
      )}
    </QueryBoundary>
  );
}

export function InventoryPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<'receive' | 'new' | 'types' | null>(null);
  // Tab values of the former page (materials, material-types, products) fall back to the first tab.
  const requested = params.get('tab');
  const tab: InventoryTab =
    requested && (TABS as string[]).includes(requested) ? (requested as InventoryTab) : 'filament';
  const kind: MaterialKind = tab === 'spools' ? 'filament' : TAB_KIND[tab];
  const canManage = can('inventory.manage');
  const canRead = can('inventory.read');
  const totals = useQuery({ ...allMaterialsQuery(), enabled: canRead });

  const switcher = (
    <SectionSwitcher
      label="Inventory sections"
      selected={tab}
      sections={TABS.map((id) => ({ id, label: id === 'spools' ? 'Spools' : TAB_LABEL[id] }))}
      onChange={(id) => setParams(new URLSearchParams({ tab: id }), { replace: true })}
    />
  );
  const actions = canRead ? (
    <>
      {canManage && (
        <Button renderIcon={Add} onClick={() => setDialog('receive')}>
          Receive stock
        </Button>
      )}
      <OverflowMenu aria-label="More inventory actions" iconDescription="More inventory actions" flipped>
        {canManage && <OverflowMenuItem itemText="New article" onClick={() => setDialog('new')} />}
        <OverflowMenuItem itemText="Types & categories" onClick={() => setDialog('types')} />
      </OverflowMenu>
    </>
  ) : undefined;
  const header = {
    title: 'Inventory',
    width: 'wide' as const,
    actions,
    description: totals.data
      ? `Filament, consumables, parts and spools. Stock value ${formatMoney(totals.data.totalInventoryValue)}.`
      : 'Filament, consumables, parts and spools.',
    breadcrumbs: [{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Inventory' }],
  };
  if (!canRead)
    return (
      <PageShell {...header}>
        <NoInventoryAccess />
      </PageShell>
    );
  const close = () => setDialog(null);

  return (
    <PageShell {...header}>
      {tab === 'spools' ? (
        <InventorySpoolsTable switcher={switcher} />
      ) : (
        <ArticlesTab tab={tab} canManage={canManage} onReceive={() => setDialog('receive')} switcher={switcher} />
      )}
      {dialog === 'receive' && <ReceiveStockModal open onClose={close} kind={kind} />}
      {dialog === 'new' && <MaterialFormModal open onClose={close} kind={kind} />}
      {dialog === 'types' && <MaterialTypesModal open onClose={close} initialKind={kind} canManage={canManage} />}
    </PageShell>
  );
}
