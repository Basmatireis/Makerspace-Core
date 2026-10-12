import { useState } from 'react';
import { Button, OverflowMenu, OverflowMenuItem, Tile } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { Link, useParams } from 'react-router-dom';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { PageShell } from '../../../app/PageShell';
import { EmptyState } from '../../../app/PageState';
import { InventoryLedgerTable } from '../components/InventoryLedgerTable';
import { InventorySpoolsTable } from '../components/InventorySpoolsTable';
import { ProductsTable } from '../components/ProductsTable';
import { formatQuantity, formatUnitCost, isFilament, looseStock, NoInventoryAccess, onSpoolsStock, StockTag, stockState, unitLabel } from '../components/inventoryShared';
import { QueryBoundary } from '../components/QueryBoundary';
import { formatMoney } from '../derived';
import { MaterialFormModal } from '../dialogs/MaterialFormModal';
import { ProductFormModal } from '../dialogs/ProductFormModal';
import { SpoolFormModal } from '../dialogs/SpoolFormModal';
import { StockMovementModal, type MovementMode } from '../dialogs/StockMovementModal';
import { useSimulatedMutation, useSimulatedQuery, useStore } from '../store';
import type { FilamentProduct, InventoryTransaction, Material, Spool } from '../types';
import '../styles/inventory.scss';

const crumbs = [{ label: 'Workshop', to: '/' }, { label: 'Inventory', to: '/inventory' }];
type Dialog = 'movement' | 'edit' | 'empty' | 'spool' | 'product' | null;

function MaterialDetail({ material, transactions, spools }: { material: Material; transactions: InventoryTransaction[]; spools: Spool[] }) {
  const store = useStore();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mode, setMode] = useState<MovementMode>('purchase');
  const [editing, setEditing] = useState<FilamentProduct | undefined>();
  const openMovement = (next: MovementMode) => { setMode(next); setDialog('movement'); };
  const close = () => setDialog(null);
  const canManage = store.can('inventory.manage');
  const canRegister = store.can('filament_spools.manage');
  const filament = isFilament(material);
  const { mutate: markEmpty, pending: emptying } = useSimulatedMutation(() => store.markMaterialEmpty(material.id));
  const holdsSpools = spools.some((spool) => spool.lifecycle === 'active' && spool.remainingQuantity > 0);

  const actions = canManage ? (
    <>
      <Button renderIcon={Add} onClick={() => openMovement('purchase')}>Add stock</Button>
      <OverflowMenu aria-label="More material actions" iconDescription="More material actions" flipped>
        <OverflowMenuItem itemText="Record consumption" disabled={material.quantity <= 0} onClick={() => openMovement('consumption')} />
        <OverflowMenuItem itemText="Correct stock" onClick={() => openMovement('correction')} />
        <OverflowMenuItem itemText="Record disposal" disabled={material.quantity <= 0} onClick={() => openMovement('disposal')} />
        <OverflowMenuItem itemText="Mark as empty" disabled={material.quantity <= 0} onClick={() => setDialog('empty')} />
        <OverflowMenuItem itemText="Edit material" onClick={() => setDialog('edit')} />
      </OverflowMenu>
    </>
  ) : undefined;

  return (
    <PageShell
      title={material.name} titleAdornment={<StockTag state={stockState(material)} />} width="wide"
      description={`${material.category} · ${unitLabel(material.unit)}${material.active ? '' : ' · Inactive'}`}
      breadcrumbs={crumbs} actions={actions}
    >
      <div className="mj-stack">
        <Tile>
          <dl className="mj-facts">
            <div><dt>In stock</dt><dd>{formatQuantity(material.quantity, material.unit)}</dd></div>
            {filament && <div><dt>On spools</dt><dd>{formatQuantity(onSpoolsStock(material, spools), material.unit)}</dd></div>}
            {filament && <div><dt>Loose stock</dt><dd>{formatQuantity(looseStock(material, spools), material.unit)}</dd></div>}
            <div><dt>Low-stock threshold</dt><dd>{material.lowStockThreshold != null ? formatQuantity(material.lowStockThreshold, material.unit) : '—'}</dd></div>
            <div><dt>Avg. acquisition cost</dt><dd>{formatUnitCost(material.avgCostPerUnit, material.unit)}</dd></div>
            <div><dt>Stock value</dt><dd>{material.avgCostPerUnit != null ? formatMoney(material.quantity * material.avgCostPerUnit) : '—'}</dd></div>
            <div><dt>Category</dt><dd>{material.category}</dd></div>
            <div><dt>Unit</dt><dd>{unitLabel(material.unit)}</dd></div>
            {material.color && <div><dt>Colour</dt><dd>{material.color}</dd></div>}
            {material.diameterMm != null && <div><dt>Filament diameter</dt><dd>{material.diameterMm} mm</dd></div>}
          </dl>
        </Tile>
        <section className="mj-inventory-section" aria-labelledby="material-ledger-title">
          <h2 id="material-ledger-title" className="mj-section-title">Ledger</h2>
          <InventoryLedgerTable id="ledger" transactions={transactions} unit={material.unit} showSpool={filament} />
        </section>
        {filament && (
          <section className="mj-inventory-section" aria-labelledby="material-products-title">
            <h2 id="material-products-title" className="mj-section-title">Products</h2>
            <ProductsTable
              id="products" materialId={material.id} canManage={canManage}
              onAdd={() => { setEditing(undefined); setDialog('product'); }} onEdit={(product) => { setEditing(product); setDialog('product'); }}
            />
          </section>
        )}
        {filament && (
          <section className="mj-inventory-section" aria-labelledby="material-spools-title">
            <h2 id="material-spools-title" className="mj-section-title">Spools</h2>
            <InventorySpoolsTable id="spools" spools={spools} fixedMaterial canRegister={canRegister && material.active} onRegister={() => setDialog('spool')} />
          </section>
        )}
      </div>
      <StockMovementModal open={dialog === 'movement'} onClose={close} mode={mode} material={material} />
      <MaterialFormModal open={dialog === 'edit'} onClose={close} material={material} />
      <ProductFormModal open={dialog === 'product'} onClose={close} product={editing} materialId={material.id} />
      <SpoolFormModal open={dialog === 'spool'} onClose={close} materialId={material.id} />
      <DestructiveActionDialog
        open={dialog === 'empty'} title="Mark as empty?" confirmLabel="Mark as empty" pending={emptying} onClose={close}
        onConfirm={async () => { await markEmpty(); store.notify({ kind: 'success', title: 'Marked as empty', subtitle: `${material.name} stock is now 0 ${unitLabel(material.unit)}.` }); close(); }}
      >
        <p>
          The remaining {formatQuantity(material.quantity, material.unit)} of {material.name} is written off as a disposal and stock becomes 0.
          {holdsSpools && ' Active spools of this material are marked empty and removed from their printer slots.'} The ledger keeps every entry.
        </p>
      </DestructiveActionDialog>
    </PageShell>
  );
}

export function MaterialDetailPage() {
  const { materialId } = useParams();
  const store = useStore();
  const query = useSimulatedQuery((data) => ({
    material: data.materials.find((item) => item.id === materialId) ?? null,
    transactions: data.transactions.filter((tx) => tx.materialId === materialId),
    spools: data.spools.filter((spool) => spool.materialId === materialId),
  }), { material: null, transactions: [], spools: [] } as { material: Material | null; transactions: InventoryTransaction[]; spools: Spool[] });
  if (!store.can('inventory.read')) return <PageShell title="Material" breadcrumbs={crumbs} width="wide"><NoInventoryAccess /></PageShell>;
  if (query.status === 'success' && query.data.material) return <MaterialDetail material={query.data.material} transactions={query.data.transactions} spools={query.data.spools} />;
  return (
    <PageShell title={query.status === 'success' ? 'Material not found' : 'Material'} breadcrumbs={crumbs} width="wide">
      <QueryBoundary query={query} errorMessage="The material could not be loaded.">
        <EmptyState title="This material does not exist" description="It may have been removed, or the link is incorrect." action={<Button kind="tertiary" as={Link} to="/inventory">Back to inventory</Button>} />
      </QueryBoundary>
    </PageShell>
  );
}
