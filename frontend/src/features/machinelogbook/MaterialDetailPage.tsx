import { useState } from 'react';
import { Button, OverflowMenu, OverflowMenuItem, Tile } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { deleteMaterial, markMaterialEmpty } from '../../api/generated/inventory/inventory';
import type { Material } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { InventoryLedgerTable } from './components/InventoryLedgerTable';
import { InventorySpoolsTable } from './components/InventorySpoolsTable';
import {
  ArticleKindTag,
  formatQuantity,
  MaterialColor,
  formatUnitCost,
  isFilament,
  materialUnitCost,
  NoInventoryAccess,
  StockTag,
  typeNoun,
  unitLabel,
} from './components/inventoryShared';
import { MaterialFormModal } from './dialogs/MaterialFormModal';
import { ReceiveStockModal } from './dialogs/ReceiveStockModal';
import { StockMovementModal, type MovementMode } from './dialogs/StockMovementModal';
import { allTransactionsQuery } from './inventoryQueries';
import { machineLogbookKeys, materialQuery } from './queries';
import { formatMoney } from './shared/format';
import { inventoryTabForKind, machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { useNotify } from './shared/toasts';
import { useCan } from './shared/useCan';
import './styles/inventory.scss';

const crumbs = [
  { label: 'Workshop', to: machineLogbookPaths.overview() },
  { label: 'Inventory', to: machineLogbookPaths.inventory() },
];
type Dialog = 'movement' | 'edit' | 'empty' | 'receive' | 'delete' | null;

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
  const navigate = useNavigate();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mode, setMode] = useState<MovementMode>('consumption');
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

  const removal = useMutation({
    mutationFn: () => deleteMaterial(material.id, { expectedVersion: material.version }),
    onSuccess: async () => {
      notify({ kind: 'success', title: 'Article deleted', subtitle: material.name });
      navigate(machineLogbookPaths.inventory(inventoryTabForKind(material.kind)));
      await client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: machineLogbookKeys.all });
    },
  });
  // Only an article nothing uses can be deleted; the backend decides, `deletable` just spares the failed attempt.
  const deletable = material.deletable !== false;

  const actions = canManage ? (
    <>
      <Button renderIcon={Add} onClick={() => setDialog('receive')}>
        Receive stock
      </Button>
      <OverflowMenu aria-label="More article actions" iconDescription="More article actions" flipped>
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
        <OverflowMenuItem itemText="Edit article" onClick={() => setDialog('edit')} />
        <OverflowMenuItem
          itemText="Delete article"
          isDelete
          hasDivider
          disabled={!deletable}
          onClick={() => setDialog('delete')}
        />
      </OverflowMenu>
    </>
  ) : undefined;

  return (
    <PageShell
      title={material.name}
      titleAdornment={
        <span className="mj-inline">
          <ArticleKindTag kind={material.kind} size="md" />
          <StockTag state={material.stockState} />
        </span>
      }
      width="wide"
      description={[
        `${typeNoun(material.kind) === 'Category' ? 'Category' : 'Type'}: ${material.materialTypeName}`,
        material.variant,
        material.colorName,
        material.manufacturer,
        material.active ? null : 'Inactive',
      ]
        .filter(Boolean)
        .join(' · ')}
      breadcrumbs={[
        crumbs[0],
        { label: 'Inventory', to: machineLogbookPaths.inventory(inventoryTabForKind(material.kind)) },
        { label: material.name },
      ]}
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
              <dt>Average cost</dt>
              <dd>{formatUnitCost(materialUnitCost(material), material.unit)}</dd>
            </div>
            <div>
              <dt>Stock value</dt>
              <dd>{formatMoney(material.inventoryValue)}</dd>
            </div>
            <div>
              <dt>Sale price</dt>
              <dd>
                {material.salePrice != null ? `${formatMoney(material.salePrice)} / ${unitLabel(material.unit)}` : '—'}
              </dd>
            </div>
            <div>
              <dt>Package size</dt>
              <dd>{material.packageSize != null ? formatQuantity(material.packageSize, material.unit) : '—'}</dd>
            </div>
            <div>
              <dt>Storage location</dt>
              <dd>{material.storageLocation || '—'}</dd>
            </div>
            <div>
              <dt>{typeNoun(material.kind) === 'Category' ? 'Category' : 'Material type'}</dt>
              <dd>{material.materialTypeName}</dd>
            </div>
            {material.variant && (
              <div>
                <dt>Variant</dt>
                <dd>{material.variant}</dd>
              </div>
            )}
            {(material.colorName || material.colorHex) && (
              <div>
                <dt>Colour</dt>
                <dd>
                  <MaterialColor name={material.colorName} hex={material.colorHex} />
                </dd>
              </div>
            )}
            {material.manufacturer && (
              <div>
                <dt>Manufacturer</dt>
                <dd>{material.manufacturer}</dd>
              </div>
            )}
            <div>
              <dt>Unit</dt>
              <dd>{unitLabel(material.unit)}</dd>
            </div>
            {material.filamentDiameterMm != null && (
              <div>
                <dt>Filament diameter</dt>
                <dd>{Number(material.filamentDiameterMm)} mm</dd>
              </div>
            )}
            {material.notes && (
              <div>
                <dt>Notes</dt>
                <dd>{material.notes}</dd>
              </div>
            )}
          </dl>
        </Tile>
        {canManage && !deletable && (
          <p className="mj-secondary">
            Used by ledger entries, spools or orders, so this article cannot be deleted. Deactivate it instead (Edit
            article).
          </p>
        )}
        <section className="mj-inventory-section" aria-labelledby="material-ledger-title">
          <h2 id="material-ledger-title" className="mj-section-title">
            Ledger
          </h2>
          <Ledger material={material} />
        </section>
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
      {dialog === 'receive' && <ReceiveStockModal open onClose={close} kind={material.kind} article={material} />}
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
      <DestructiveActionDialog
        open={dialog === 'delete'}
        title="Delete this article?"
        confirmLabel="Delete article"
        pending={removal.isPending}
        onClose={close}
        error={
          removal.isError
            ? removal.error instanceof ApiError
              ? removal.error.message
              : 'The article could not be deleted. Reload the page and try again.'
            : undefined
        }
        onConfirm={() => removal.mutate()}
      >
        <p>{material.name} will be deleted permanently. This cannot be undone.</p>
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
      <PageShell title="Article" breadcrumbs={crumbs} width="wide">
        <NoInventoryAccess />
      </PageShell>
    );
  if (query.status === 'success') return <MaterialDetail material={query.data} />;
  const missing = query.error instanceof ApiError && query.error.status === 404;
  return (
    <PageShell title={missing ? 'Article not found' : 'Article'} breadcrumbs={crumbs} width="wide">
      {missing ? (
        <EmptyState
          title="This article does not exist"
          description="It may have been removed, or the link is incorrect."
          action={
            <Button kind="tertiary" as={Link} to={machineLogbookPaths.inventory()}>
              Back to inventory
            </Button>
          }
        />
      ) : (
        <QueryBoundary query={query} errorMessage="The article could not be loaded.">
          {null}
        </QueryBoundary>
      )}
    </PageShell>
  );
}
