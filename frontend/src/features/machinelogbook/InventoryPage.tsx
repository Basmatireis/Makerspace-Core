import { useMemo, useState } from 'react';
import { Button, Link as CarbonLink, MenuButton, MenuItem, MultiSelect, Tab, TabList, TabPanel, TabPanels, Tabs, Toggle } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { FilamentProduct, Material } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { InventorySpoolsTable } from './components/InventorySpoolsTable';
import { ProductsTable } from './components/ProductsTable';
import { categoryLabel, formatQuantity, formatUnitCost, isFilament, materialUnitCost, NoInventoryAccess, StockTag, stockStateOptions, unitLabel } from './components/inventoryShared';
import { MaterialFormModal } from './dialogs/MaterialFormModal';
import { ProductFormModal } from './dialogs/ProductFormModal';
import { SpoolFormModal } from './dialogs/SpoolFormModal';
import { activeSpoolCountsQuery, allMaterialsQuery } from './inventoryQueries';
import { DirectoryTable, selectedOptions, useUrlState, type Column, type Option } from './shared/DirectoryTable';
import { machineLogbookPaths, type InventoryTab } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { useCan } from './shared/useCan';
import './styles/inventory.scss';

const TABS: InventoryTab[] = ['materials', 'spools', 'products'];
const MATERIAL_FILTERS = ['category', 'stock', 'inactive'];

type MaterialRow = Material & { activeSpools: number | null };

function MaterialsTable({ materials, canAdd, canRegister, onAdd, onRegister }: {
  materials: Material[]; canAdd: boolean; canRegister: boolean; onAdd: () => void; onRegister: () => void;
}) {
  const url = useUrlState('materials');
  const categoryIds = url.list('category');
  const stockIds = url.list('stock');
  const showInactive = url.get('inactive') === '1';
  const filament = materials.some(isFilament);
  const counts = useQuery({ ...activeSpoolCountsQuery(), enabled: filament });

  const all: MaterialRow[] = useMemo(() => materials.map((material) => ({
    ...material, activeSpools: isFilament(material) && counts.data ? counts.data[material.id] ?? 0 : null,
  })), [materials, counts.data]);
  const categoryOptions: Option[] = [...new Set(materials.map((material) => material.category))].sort().map((category) => ({ id: category, label: categoryLabel(category) }));
  const rows = all.filter((row) => (showInactive || row.active)
    && (categoryIds.length === 0 || categoryIds.includes(row.category))
    && (stockIds.length === 0 || stockIds.includes(row.stockState)));

  const columns: Column<MaterialRow>[] = [
    {
      key: 'material', header: 'Material', sortValue: (row) => row.name,
      render: (row) => (
        <div className="mj-cell-stack">
          <CarbonLink as={Link} to={machineLogbookPaths.material(row.id)}>{row.name}</CarbonLink>
          <span className="mj-secondary">{[categoryLabel(row.category), unitLabel(row.unit), row.active ? null : 'Inactive'].filter(Boolean).join(' · ')}</span>
        </div>
      ),
    },
    {
      key: 'quantity', header: 'In stock', sortValue: (row) => Number(row.quantity), firstDirection: 'DESC',
      render: (row) => (
        <div className="mj-cell-stack">
          <span>{formatQuantity(row.quantity, row.unit)}</span>
          {isFilament(row) && <span className="mj-secondary">{formatQuantity(row.assignedQuantity, row.unit)} on spools · {formatQuantity(row.unassignedQuantity, row.unit)} loose</span>}
        </div>
      ),
    },
    { key: 'state', header: 'Stock', sortValue: (row) => row.stockState, render: (row) => <StockTag state={row.stockState} size="sm" /> },
    {
      key: 'threshold', header: 'Low-stock threshold', narrow: true, sortValue: (row) => row.lowStockThreshold != null ? Number(row.lowStockThreshold) : -1, firstDirection: 'DESC',
      render: (row) => row.lowStockThreshold != null ? formatQuantity(row.lowStockThreshold, row.unit) : '—',
    },
    {
      key: 'cost', header: 'Avg. cost', narrow: true, sortValue: (row) => Number(materialUnitCost(row) ?? -1), firstDirection: 'DESC',
      render: (row) => formatUnitCost(materialUnitCost(row), row.unit),
    },
    { key: 'spools', header: 'Spools', narrow: true, sortValue: (row) => row.activeSpools ?? -1, firstDirection: 'DESC', render: (row) => row.activeSpools ?? '—' },
  ];

  const action = canAdd && canRegister
    ? (
      <MenuButton label="New" kind="primary" size="lg" menuAlignment="bottom-end">
        <MenuItem label="Add material" onClick={onAdd} />
        <MenuItem label="Register spool" onClick={onRegister} />
      </MenuButton>
    )
    : canAdd ? <Button kind="primary" size="lg" onClick={onAdd}>Add material</Button>
      : canRegister ? <Button kind="primary" size="lg" onClick={onRegister}>Register spool</Button> : undefined;

  return (
    <DirectoryTable
      id="materials" label="Materials" columns={columns} rows={rows} totalCount={materials.length}
      searchText={(row) => [row.name, row.category, row.color].filter(Boolean).join(' ')}
      defaultSort={{ key: 'material', direction: 'ASC' }}
      hasActiveFilters={MATERIAL_FILTERS.some((key) => url.get(key))} onClearFilters={() => url.clear(MATERIAL_FILTERS)}
      toolbarAction={action}
      filterFields={(
        <>
          <MultiSelect
            id="materials-category-filter" className="mj-filter-panel__field" titleText="Category" label="All categories" items={categoryOptions}
            itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(categoryOptions, categoryIds)} onChange={({ selectedItems }) => url.setList('category', selectedItems)}
          />
          <MultiSelect
            id="materials-stock-filter" className="mj-filter-panel__field" titleText="Stock state" label="All states" items={stockStateOptions}
            itemToString={(item) => item?.label ?? ''} selectedItems={selectedOptions(stockStateOptions, stockIds) as typeof stockStateOptions} onChange={({ selectedItems }) => url.setList('stock', selectedItems)}
          />
          <div className="mj-filter-panel__field">
            <Toggle id="materials-inactive-filter" size="sm" labelText="Show inactive" labelA="Hidden" labelB="Shown" toggled={showInactive} onToggle={(checked) => url.set({ inactive: checked ? '1' : null })} />
          </div>
        </>
      )}
      empty={{
        title: 'No materials yet', description: 'Add the materials the makerspace keeps in stock to track quantities and costs.',
        action: canAdd ? <Button kind="tertiary" onClick={onAdd}>Add material</Button> : undefined,
      }}
    />
  );
}

function MaterialsTab({ canAdd, canRegister, onAdd, onRegister }: { canAdd: boolean; canRegister: boolean; onAdd: () => void; onRegister: () => void }) {
  const query = useQuery(allMaterialsQuery());
  return (
    <QueryBoundary query={query} errorMessage="The materials could not be loaded.">
      {(materials) => <MaterialsTable materials={materials} canAdd={canAdd} canRegister={canRegister} onAdd={onAdd} onRegister={onRegister} />}
    </QueryBoundary>
  );
}

export function InventoryPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [materialOpen, setMaterialOpen] = useState(false);
  const [spoolOpen, setSpoolOpen] = useState(false);
  const [productOpen, setProductOpen] = useState(false);
  const [editing, setEditing] = useState<FilamentProduct | undefined>();
  const requested = params.get('tab') as InventoryTab | null;
  const tab: InventoryTab = requested && TABS.includes(requested) ? requested : 'materials';
  const canAdd = can('inventory.manage');
  const canRegister = can('filament_spools.manage') && can('inventory.manage');

  const header = { title: 'Inventory', description: 'Materials, filament spools and the filament product catalog.', breadcrumbs: [{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Inventory' }], width: 'wide' as const };
  if (!can('inventory.read')) return <PageShell {...header}><NoInventoryAccess /></PageShell>;

  return (
    <PageShell {...header}>
      <Tabs
        selectedIndex={TABS.indexOf(tab)}
        onChange={({ selectedIndex }) => setParams((current) => { const next = new URLSearchParams(current); next.set('tab', TABS[selectedIndex] ?? 'materials'); return next; }, { replace: true })}
      >
        <TabList aria-label="Inventory sections" contained>
          <Tab>Materials</Tab>
          <Tab>Spools</Tab>
          <Tab>Products</Tab>
        </TabList>
        <TabPanels>
          <TabPanel className="mj-tab-panel">
            <div>
              {tab === 'materials' && <MaterialsTab canAdd={canAdd} canRegister={canRegister} onAdd={() => setMaterialOpen(true)} onRegister={() => setSpoolOpen(true)} />}
            </div>
          </TabPanel>
          <TabPanel className="mj-tab-panel">
            <div>
              {tab === 'spools' && <InventorySpoolsTable />}
            </div>
          </TabPanel>
          <TabPanel className="mj-tab-panel">
            <div>
              {tab === 'products' && (
                <ProductsTable
                  id="products" canManage={canAdd}
                  onAdd={() => { setEditing(undefined); setProductOpen(true); }} onEdit={(product) => { setEditing(product); setProductOpen(true); }}
                />
              )}
            </div>
          </TabPanel>
        </TabPanels>
      </Tabs>
      {materialOpen && <MaterialFormModal open onClose={() => setMaterialOpen(false)} />}
      {spoolOpen && <SpoolFormModal open onClose={() => setSpoolOpen(false)} />}
      {productOpen && <ProductFormModal open onClose={() => setProductOpen(false)} product={editing} />}
    </PageShell>
  );
}
