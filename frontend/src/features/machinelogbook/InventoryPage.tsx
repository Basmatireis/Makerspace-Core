import { useMemo, useState, type ReactNode } from 'react';
import { Button, Link as CarbonLink, MenuButton, MenuItem } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { FilamentProduct, Material, MaterialType } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { SectionSwitcher } from '../../app/SectionSwitcher';
import { InventorySpoolsTable } from './components/InventorySpoolsTable';
import { MaterialTypesTable } from './components/MaterialTypesTable';
import { ProductsTable } from './components/ProductsTable';
import { formatQuantity, MaterialColor, formatUnitCost, isFilament, materialUnitCost, NoInventoryAccess, StockTag, stockStateOptions, unitLabel } from './components/inventoryShared';
import { DeleteMaterialTypeModal } from './dialogs/DeleteMaterialTypeModal';
import { MaterialFormModal } from './dialogs/MaterialFormModal';
import { MaterialTypeFormModal } from './dialogs/MaterialTypeFormModal';
import { ProductFormModal } from './dialogs/ProductFormModal';
import { SpoolFormModal } from './dialogs/SpoolFormModal';
import { activeSpoolCountsQuery, allMaterialsQuery } from './inventoryQueries';
import { DirectoryTable, useUrlState, type Column, type Option } from './shared/DirectoryTable';
import { machineLogbookPaths, type InventoryTab } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { useCan } from './shared/useCan';
import './styles/inventory.scss';

const TABS: InventoryTab[] = ['materials', 'material-types', 'spools', 'products'];

type MaterialRow = Material & { activeSpools: number | null };

function MaterialsTable({ materials, canAdd, canRegister, onAdd, onRegister, switcher }: {
  switcher: ReactNode; materials: Material[]; canAdd: boolean; canRegister: boolean; onAdd: () => void; onRegister: () => void;
}) {
  const url = useUrlState('materials');
  const typeIds = url.list('type');
  const stockIds = url.list('stock');
  const showInactive = url.get('inactive') === '1';
  const filament = materials.some(isFilament);
  const counts = useQuery({ ...activeSpoolCountsQuery(), enabled: filament });

  const all: MaterialRow[] = useMemo(() => materials.map((material) => ({
    ...material, activeSpools: isFilament(material) && counts.data ? counts.data[material.id] ?? 0 : null,
  })), [materials, counts.data]);
  const typeOptions: Option[] = [...new Map(materials.map((material) => [material.materialTypeId, material.materialTypeName])).entries()].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label));
  const rows = all.filter((row) => (showInactive || row.active)
    && (typeIds.length === 0 || typeIds.includes(row.materialTypeId))
    && (stockIds.length === 0 || stockIds.includes(row.stockState)));

  const columns: Column<MaterialRow>[] = [
    {
      key: 'material', header: 'Material', sortValue: (row) => row.name,
      render: (row) => (
        <div className="mj-cell-stack">
          <CarbonLink as={Link} to={machineLogbookPaths.material(row.id)}>{row.name}</CarbonLink>
          <span className="mj-secondary">{[row.materialTypeName, unitLabel(row.unit), row.active ? null : 'Inactive'].filter(Boolean).join(' · ')}</span>
        </div>
      ),
    },
    { key: 'colour', header: 'Colour', narrow: true, sortValue: (row) => row.colorName ?? '', render: (row) => <MaterialColor name={row.colorName} hex={row.colorHex} /> },
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
      switcher={switcher} id="materials" label="Materials" columns={columns} rows={rows} totalCount={materials.length}
      searchText={(row) => [row.name, row.materialTypeName, row.colorName].filter(Boolean).join(' ')}
      defaultSort={{ key: 'material', direction: 'ASC' }}
      toolbarAction={action}
      filterCategories={[
        { key: 'type', label: 'Material type', options: typeOptions },
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

function MaterialsTab({ canAdd, canRegister, onAdd, onRegister, switcher }: { switcher: ReactNode; canAdd: boolean; canRegister: boolean; onAdd: () => void; onRegister: () => void }) {
  const query = useQuery(allMaterialsQuery());
  return (
    <QueryBoundary query={query} errorMessage="The materials could not be loaded.">
      {(materials) => <MaterialsTable switcher={switcher} materials={materials} canAdd={canAdd} canRegister={canRegister} onAdd={onAdd} onRegister={onRegister} />}
    </QueryBoundary>
  );
}

export function InventoryPage() {
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [materialOpen, setMaterialOpen] = useState(false);
  const [spoolOpen, setSpoolOpen] = useState(false);
  const [productOpen, setProductOpen] = useState(false);
  const [typeOpen, setTypeOpen] = useState(false);
  const [editingType, setEditingType] = useState<MaterialType | undefined>();
  const [deletingType, setDeletingType] = useState<MaterialType | undefined>();
  const [editing, setEditing] = useState<FilamentProduct | undefined>();
  const requested = params.get('tab') as InventoryTab | null;
  const tab: InventoryTab = requested && TABS.includes(requested) ? requested : 'materials';
  const canAdd = can('inventory.manage');
  const canRegister = can('filament_spools.manage') && can('inventory.manage');

  const switcher = (
    <SectionSwitcher
      label="Inventory sections" selected={tab}
      sections={[{ id: 'materials', label: 'Materials' }, { id: 'material-types', label: 'Material types' }, { id: 'spools', label: 'Spools' }, { id: 'products', label: 'Products' }]}
      onChange={(id) => setParams((current) => { const next = new URLSearchParams(current); next.set('tab', id); return next; }, { replace: true })}
    />
  );
  const header = { title: 'Inventory', description: 'Materials, material types, filament spools and the filament product catalog.', breadcrumbs: [{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Inventory' }], width: 'wide' as const };
  if (!can('inventory.read')) return <PageShell {...header}><NoInventoryAccess /></PageShell>;

  return (
    <PageShell {...header}>
      {tab === 'materials' && <MaterialsTab switcher={switcher} canAdd={canAdd} canRegister={canRegister} onAdd={() => setMaterialOpen(true)} onRegister={() => setSpoolOpen(true)} />}
      {tab === 'material-types' && (
        <MaterialTypesTable
          switcher={switcher} id="material-types" canManage={canAdd}
          onAdd={() => { setEditingType(undefined); setTypeOpen(true); }} onEdit={(materialType) => { setEditingType(materialType); setTypeOpen(true); }}
        />
      )}
      {tab === 'spools' && <InventorySpoolsTable switcher={switcher} />}
      {tab === 'products' && (
        <ProductsTable
          switcher={switcher} id="products" canManage={canAdd}
          onAdd={() => { setEditing(undefined); setProductOpen(true); }} onEdit={(product) => { setEditing(product); setProductOpen(true); }}
        />
      )}
      {materialOpen && <MaterialFormModal open onClose={() => setMaterialOpen(false)} />}
      {typeOpen && (
        <MaterialTypeFormModal
          open onClose={() => setTypeOpen(false)} materialType={editingType}
          onDelete={editingType ? () => { setDeletingType(editingType); setTypeOpen(false); } : undefined}
        />
      )}
      {deletingType && <DeleteMaterialTypeModal materialType={deletingType} onClose={() => setDeletingType(undefined)} />}
      {spoolOpen && <SpoolFormModal open onClose={() => setSpoolOpen(false)} />}
      {productOpen && <ProductFormModal open onClose={() => setProductOpen(false)} product={editing} />}
    </PageShell>
  );
}
