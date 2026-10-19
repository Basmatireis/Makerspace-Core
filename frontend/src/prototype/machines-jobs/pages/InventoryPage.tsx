import { useMemo, useState } from 'react';
import { Button, Link as CarbonLink, MenuButton, MenuItem, Tab, TabList, TabPanel, TabPanels, Tabs } from '@carbon/react';
import { Link, useSearchParams } from 'react-router-dom';
import { PageShell } from '../../../app/PageShell';
import { DirectoryTable, useUrlState, type Column, type Option } from '../components/DirectoryTable';
import { InventorySpoolsTable } from '../components/InventorySpoolsTable';
import { ProductsTable } from '../components/ProductsTable';
import { formatQuantity, formatUnitCost, isFilament, looseStock, onSpoolsStock, NoInventoryAccess, StockTag, stockState, stockStateOptions, type StockState } from '../components/inventoryShared';
import { QueryBoundary } from '../components/QueryBoundary';
import { ChangeFilamentModal } from '../dialogs/ChangeFilamentModal';
import { CleanupSpoolsModal } from '../dialogs/CleanupSpoolsModal';
import { MaterialFormModal } from '../dialogs/MaterialFormModal';
import { ProductFormModal } from '../dialogs/ProductFormModal';
import { SpoolFormModal } from '../dialogs/SpoolFormModal';
import { useSimulatedQuery, useStore } from '../store';
import type { FilamentProduct, Material, Spool } from '../types';
import '../styles/inventory.scss';

type TabKey = 'materials' | 'spools' | 'products';
const TABS: TabKey[] = ['materials', 'spools', 'products'];
const EMPTY: { materials: Material[]; spools: Spool[] } = { materials: [], spools: [] };

type MaterialRow = Material & { state: StockState; activeSpools: number | null };

function MaterialsTable({ materials, spools, canAdd, canRegister, onAdd, onRegister }: {
  materials: Material[]; spools: Spool[]; canAdd: boolean; canRegister: boolean; onAdd: () => void; onRegister: () => void;
}) {
  const url = useUrlState('materials');
  const categoryIds = url.list('category');
  const stockIds = url.list('stock');
  const showInactive = url.get('inactive') === '1';

  const all: MaterialRow[] = useMemo(() => materials.map((material) => ({
    ...material, state: stockState(material),
    activeSpools: isFilament(material) ? spools.filter((spool) => spool.materialId === material.id && spool.lifecycle === 'active').length : null,
  })), [materials, spools]);
  const categoryOptions: Option[] = [...new Set(materials.map((material) => material.category))].sort().map((category) => ({ id: category, label: category }));
  const rows = all.filter((row) => (showInactive || row.active)
    && (categoryIds.length === 0 || categoryIds.includes(row.category))
    && (stockIds.length === 0 || stockIds.includes(row.state)));

  const columns: Column<MaterialRow>[] = [
    {
      key: 'material', header: 'Material', sortValue: (row) => row.name,
      render: (row) => (
        <div className="mj-cell-stack">
          <CarbonLink as={Link} to={`/inventory/materials/${row.id}`}>{row.name}</CarbonLink>
          <span className="mj-secondary">{[row.category, row.unit === 'm2' ? 'm²' : row.unit, row.active ? null : 'Inactive'].filter(Boolean).join(' · ')}</span>
        </div>
      ),
    },
    {
      key: 'quantity', header: 'In stock', sortValue: (row) => row.quantity, firstDirection: 'DESC',
      render: (row) => (
        <div className="mj-cell-stack">
          <span>{formatQuantity(row.quantity, row.unit)}</span>
          {isFilament(row) && <span className="mj-secondary">{formatQuantity(onSpoolsStock(row, spools), row.unit)} on spools · {formatQuantity(looseStock(row, spools), row.unit)} loose</span>}
        </div>
      ),
    },
    { key: 'state', header: 'Stock', sortValue: (row) => row.state, render: (row) => <StockTag state={row.state} size="sm" /> },
    {
      key: 'threshold', header: 'Low-stock threshold', narrow: true, sortValue: (row) => row.lowStockThreshold ?? -1, firstDirection: 'DESC',
      render: (row) => row.lowStockThreshold != null ? formatQuantity(row.lowStockThreshold, row.unit) : '—',
    },
    { key: 'cost', header: 'Avg. cost', narrow: true, sortValue: (row) => row.avgCostPerUnit ?? -1, firstDirection: 'DESC', render: (row) => formatUnitCost(row.avgCostPerUnit, row.unit) },
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
      toolbarAction={action}
      filterCategories={[
        { key: 'category', label: 'Category', options: categoryOptions },
        { key: 'stock', label: 'Stock state', options: stockStateOptions },
        { key: 'inactive', label: 'Show', options: [{ id: '1', label: 'Inactive materials' }] },
      ]}
      empty={{
        title: 'No materials yet', description: 'Add the materials the makerspace keeps in stock to track quantities and costs.',
        action: canAdd ? <Button kind="tertiary" onClick={onAdd}>Add material</Button> : undefined,
      }}
    />
  );
}

export function InventoryPage() {
  const store = useStore();
  const [params, setParams] = useSearchParams();
  const [materialOpen, setMaterialOpen] = useState(false);
  const [spoolOpen, setSpoolOpen] = useState(false);
  const [refillOpen, setRefillOpen] = useState(false);
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const [productOpen, setProductOpen] = useState(false);
  const [editing, setEditing] = useState<FilamentProduct | undefined>();
  const query = useSimulatedQuery((data) => ({ materials: data.materials, spools: data.spools }), EMPTY);
  const requested = params.get('tab') as TabKey | null;
  const tab: TabKey = requested && TABS.includes(requested) ? requested : 'materials';
  const canAdd = store.can('inventory.manage');
  const canRegister = store.can('filament_spools.manage');

  const header = { title: 'Inventory', description: 'Materials, filament spools and the filament product catalog.', breadcrumbs: [{ label: 'Workshop', to: '/' }, { label: 'Inventory' }], width: 'wide' as const };
  if (!store.can('inventory.read')) return <PageShell {...header}><NoInventoryAccess /></PageShell>;

  return (
    <PageShell {...header}>
      <QueryBoundary query={query} errorMessage="The inventory could not be loaded.">
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
                <MaterialsTable
                  materials={query.data.materials} spools={query.data.spools} canAdd={canAdd} canRegister={canRegister}
                  onAdd={() => setMaterialOpen(true)} onRegister={() => setSpoolOpen(true)}
                />
              </div>
            </TabPanel>
            <TabPanel className="mj-tab-panel">
              <div>
                <InventorySpoolsTable
                  id="spools" spools={query.data.spools} canRegister={canRegister} onRegister={() => setSpoolOpen(true)}
                  onChangeFilament={() => setRefillOpen(true)} onCleanup={() => setCleanupOpen(true)}
                />
              </div>
            </TabPanel>
            <TabPanel className="mj-tab-panel">
              <div>
                <ProductsTable
                  id="products" canManage={canAdd}
                  onAdd={() => { setEditing(undefined); setProductOpen(true); }} onEdit={(product) => { setEditing(product); setProductOpen(true); }}
                />
              </div>
            </TabPanel>
          </TabPanels>
        </Tabs>
      </QueryBoundary>
      <MaterialFormModal open={materialOpen} onClose={() => setMaterialOpen(false)} />
      <SpoolFormModal open={spoolOpen} onClose={() => setSpoolOpen(false)} />
      <ProductFormModal open={productOpen} onClose={() => setProductOpen(false)} product={editing} />
      <ChangeFilamentModal open={refillOpen} onClose={() => setRefillOpen(false)} />
      <CleanupSpoolsModal open={cleanupOpen} onClose={() => setCleanupOpen(false)} />
    </PageShell>
  );
}
