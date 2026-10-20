import { useState } from 'react';
import { Button, OverflowMenu, OverflowMenuItem, Tile } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { markMaterialEmpty } from '../../api/generated/inventory/inventory';
import type { FilamentProduct, Material } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { InventoryLedgerTable } from './components/InventoryLedgerTable';
import { InventorySpoolsTable } from './components/InventorySpoolsTable';
import { ProductsTable } from './components/ProductsTable';
import {
  formatQuantity,
  MaterialColor,
  formatUnitCost,
  isFilament,
  materialUnitCost,
  NoInventoryAccess,
  StockTag,
  unitLabel,
} from './components/inventoryShared';
import { MaterialFormModal } from './dialogs/MaterialFormModal';
import { ProductFormModal } from './dialogs/ProductFormModal';
import { StockMovementModal, type MovementMode } from './dialogs/StockMovementModal';
import { allTransactionsQuery } from './inventoryQueries';
import { machineLogbookKeys, materialQuery } from './queries';
import { formatMoney } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { useNotify } from './shared/toasts';
import { useCan } from './shared/useCan';
import './styles/inventory.scss';

const crumbs = [
  { label: 'Workshop', to: machineLogbookPaths.overview() },
  { label: 'Inventory', to: machineLogbookPaths.inventory() },
];
type Dialog = 'movement' | 'edit' | 'empty' | 'product' | null;

function Ledger({ material }: { material: Material }) {
  const transactions = useQuery(allTransactionsQuery(material.id));
  return (
    <QueryBoundary query={transactions} errorMessage="The ledger could not be loaded.">
      {(items) => (
        <InventoryLedgerTable id="ledger" transactions={items} unit={material.unit} showSpool={isFilament(material)} />
      )}
    </QueryBoundary>
  );
}

function MaterialDetail({ material }: { material: Material }) {
  const can = useCan();
  const client = useQueryClient();
  const notify = useNotify();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mode, setMode] = useState<MovementMode>('purchase');
  const [editing, setEditing] = useState<FilamentProduct | undefined>();
  const openMovement = (next: MovementMode) => {
    setMode(next);
    setDialog('movement');
  };
  const close = () => setDialog(null);
  const canManage = can('inventory.manage');
  const filament = isFilament(material);
  const quantity = Number(material.quantity);
  // Marking empty writes off the whole balance, which is only possible when nothing of it sits on a spool.
  const onSpools = Number(material.assignedQuantity) > 0;
  const emptying = useMutation({
    mutationFn: () =>
      markMaterialEmpty(material.id, {
        occurredAt: new Date().toISOString(),
        expectedInventoryVersion: material.inventoryVersion,
      }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
      notify({
        kind: 'success',
        title: 'Marked as empty',
        subtitle: `${material.name} stock is now 0 ${unitLabel(material.unit)}.`,
      });
      close();
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
  });

  const actions = canManage ? (
    <>
      <Button renderIcon={Add} onClick={() => openMovement('purchase')}>
        Add stock
      </Button>
      <OverflowMenu aria-label="More material actions" iconDescription="More material actions" flipped>
        <OverflowMenuItem
          itemText="Record consumption"
          disabled={Number(material.unassignedQuantity) <= 0}
          onClick={() => openMovement('consumption')}
        />
        <OverflowMenuItem itemText="Correct stock" onClick={() => openMovement('correction')} />
        <OverflowMenuItem
          itemText="Record disposal"
          disabled={Number(material.unassignedQuantity) <= 0}
          onClick={() => openMovement('disposal')}
        />
        <OverflowMenuItem
          itemText="Mark as empty"
          disabled={quantity <= 0 || onSpools}
          title={onSpools ? 'Part of the stock is on spools. Empty or remove those spools first.' : undefined}
          onClick={() => setDialog('empty')}
        />
        <OverflowMenuItem itemText="Edit material" onClick={() => setDialog('edit')} />
      </OverflowMenu>
    </>
  ) : undefined;

  return (
    <PageShell
      title={material.name}
      titleAdornment={<StockTag state={material.stockState} />}
      width="wide"
      description={`${material.materialTypeName} · ${unitLabel(material.unit)}${material.active ? '' : ' · Inactive'}`}
      breadcrumbs={[...crumbs, { label: material.name }]}
      actions={actions}
    >
      <div className="mj-stack">
        <Tile>
          <dl className="mj-facts">
            <div>
              <dt>In stock</dt>
              <dd>{formatQuantity(material.quantity, material.unit)}</dd>
            </div>
            {filament && (
              <div>
                <dt>On spools</dt>
                <dd>{formatQuantity(material.assignedQuantity, material.unit)}</dd>
              </div>
            )}
            {filament && (
              <div>
                <dt>Loose stock</dt>
                <dd>{formatQuantity(material.unassignedQuantity, material.unit)}</dd>
              </div>
            )}
            <div>
              <dt>Low-stock threshold</dt>
              <dd>
                {material.lowStockThreshold != null ? formatQuantity(material.lowStockThreshold, material.unit) : '—'}
              </dd>
            </div>
            <div>
              <dt>Avg. acquisition cost</dt>
              <dd>{formatUnitCost(materialUnitCost(material), material.unit)}</dd>
            </div>
            <div>
              <dt>Stock value</dt>
              <dd>{formatMoney(material.inventoryValue)}</dd>
            </div>
            <div>
              <dt>Material type</dt>
              <dd>{material.materialTypeName}</dd>
            </div>
            <div>
              <dt>Unit</dt>
              <dd>{unitLabel(material.unit)}</dd>
            </div>
            {(material.colorName || material.colorHex) && (
              <div>
                <dt>Colour</dt>
                <dd>
                  <MaterialColor name={material.colorName} hex={material.colorHex} />
                </dd>
              </div>
            )}
            {material.filamentDiameterMm != null && (
              <div>
                <dt>Filament diameter</dt>
                <dd>{Number(material.filamentDiameterMm)} mm</dd>
              </div>
            )}
          </dl>
        </Tile>
        <section className="mj-inventory-section" aria-labelledby="material-ledger-title">
          <h2 id="material-ledger-title" className="mj-section-title">
            Ledger
          </h2>
          <Ledger material={material} />
        </section>
        {filament && (
          <section className="mj-inventory-section" aria-labelledby="material-products-title">
            <h2 id="material-products-title" className="mj-section-title">
              Products
            </h2>
            <ProductsTable
              id="products"
              materialId={material.id}
              canManage={canManage}
              onAdd={() => {
                setEditing(undefined);
                setDialog('product');
              }}
              onEdit={(product) => {
                setEditing(product);
                setDialog('product');
              }}
            />
          </section>
        )}
        {filament && (
          <section className="mj-inventory-section" aria-labelledby="material-spools-title">
            <h2 id="material-spools-title" className="mj-section-title">
              Spools
            </h2>
            <InventorySpoolsTable materialId={material.id} compact />
          </section>
        )}
      </div>
      {dialog === 'movement' && <StockMovementModal open onClose={close} mode={mode} material={material} />}
      {dialog === 'edit' && <MaterialFormModal open onClose={close} material={material} />}
      {dialog === 'product' && <ProductFormModal open onClose={close} product={editing} materialId={material.id} />}
      <DestructiveActionDialog
        open={dialog === 'empty'}
        title="Mark as empty?"
        confirmLabel="Mark as empty"
        pending={emptying.isPending}
        onClose={close}
        error={
          emptying.isError
            ? emptying.error instanceof ApiError
              ? emptying.error.message
              : 'The stock may have changed. Reload the page and try again.'
            : undefined
        }
        onConfirm={() => emptying.mutate()}
      >
        <p>
          The remaining {formatQuantity(material.quantity, material.unit)} of {material.name} is written off as a
          disposal and stock becomes 0. The ledger keeps every entry.
        </p>
      </DestructiveActionDialog>
    </PageShell>
  );
}

export function MaterialDetailPage() {
  const { materialId = '' } = useParams();
  const can = useCan();
  const query = useQuery({ ...materialQuery(materialId), enabled: can('inventory.read') });
  if (!can('inventory.read'))
    return (
      <PageShell title="Material" breadcrumbs={crumbs} width="wide">
        <NoInventoryAccess />
      </PageShell>
    );
  if (query.status === 'success') return <MaterialDetail material={query.data} />;
  const missing = query.error instanceof ApiError && query.error.status === 404;
  return (
    <PageShell title={missing ? 'Material not found' : 'Material'} breadcrumbs={crumbs} width="wide">
      {missing ? (
        <EmptyState
          title="This material does not exist"
          description="It may have been removed, or the link is incorrect."
          action={
            <Button kind="tertiary" as={Link} to={machineLogbookPaths.inventory()}>
              Back to inventory
            </Button>
          }
        />
      ) : (
        <QueryBoundary query={query} errorMessage="The material could not be loaded.">
          {null}
        </QueryBoundary>
      )}
    </PageShell>
  );
}
