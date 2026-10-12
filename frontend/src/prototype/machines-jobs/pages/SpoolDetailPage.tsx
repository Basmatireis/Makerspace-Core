import { useState } from 'react';
import { Button, InlineNotification, Link as CarbonLink, OverflowMenu, OverflowMenuItem, ProgressBar, Tile, Toggletip, ToggletipButton, ToggletipContent } from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { Link, useParams } from 'react-router-dom';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { formatDate } from '../../../app/dateTime';
import { PageShell } from '../../../app/PageShell';
import { EmptyState } from '../../../app/PageState';
import { DirectoryTable, type Column } from '../components/DirectoryTable';
import { InventoryLedgerTable } from '../components/InventoryLedgerTable';
import {
  formatGrams, formatUnitCost, identifierLabel, KindTag, LifecycleTag, mountedOn, needsRefill, NoInventoryAccess, OutcomeTag, spoolNameText, spoolPercent, spoolRemainingText, spoolTitle,
} from '../components/inventoryShared';
import { QueryBoundary } from '../components/QueryBoundary';
import { formatDateTime, formatMoney } from '../derived';
import { ChangeFilamentModal } from '../dialogs/ChangeFilamentModal';
import { FinishSpoolModal } from '../dialogs/FinishSpoolModal';
import { IdentifierModal } from '../dialogs/IdentifierModal';
import { SpoolFormModal } from '../dialogs/SpoolFormModal';
import { StockMovementModal, type MovementMode } from '../dialogs/StockMovementModal';
import { useSimulatedMutation, useSimulatedQuery, useStore } from '../store';
import type { InventoryTransaction, Material, Spool, SpoolFill, SpoolIdentifier } from '../types';
import '../styles/inventory.scss';

const crumbs = [{ label: 'Workshop', to: '/' }, { label: 'Inventory', to: '/inventory' }, { label: 'Spools', to: '/inventory?tab=spools' }];
type Dialog = 'movement' | 'identifier' | 'edit' | 'finish' | 'refill' | 'archive' | 'restore' | null;
type Data = { spool: Spool | null; material: Material | null; transactions: InventoryTransaction[] };

function SpoolDetail({ spool, material, transactions }: { spool: Spool; material: Material | null; transactions: InventoryTransaction[] }) {
  const store = useStore();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mode, setMode] = useState<MovementMode>('consumption');
  const [removing, setRemoving] = useState<SpoolIdentifier | null>(null);
  const close = () => setDialog(null);
  const canManage = store.can('filament_spools.manage');
  const mount = spool.mounted ? mountedOn(spool.id, store.printerProfiles, store.machines) : null;
  const { mutate: setLifecycle, pending: changing } = useSimulatedMutation(store.setSpoolLifecycle);
  const { mutate: removeIdentifier, pending: removingPending } = useSimulatedMutation(store.removeIdentifier);
  const openMovement = (next: MovementMode) => { setMode(next); setDialog('movement'); };
  const percent = spoolPercent(spool);
  const averageCost = spool.purchasePrice != null && spool.initialNetWeightG > 0 ? spool.purchasePrice / spool.initialNetWeightG : material?.avgCostPerUnit;
  const reusable = spool.kind === 'reusable';
  const empty = needsRefill(spool);
  const archived = spool.lifecycle === 'archived';
  const hasFill = Boolean(spool.filledAt);
  const restoreTarget = !hasFill ? 'empty' : 'active';
  const canRestore = reusable || spool.remainingQuantity > 0;

  const actions = canManage ? (
    <>
      {reusable && !archived && <Button renderIcon={Add} onClick={() => setDialog('refill')}>{empty ? 'Fill spool' : 'Change filament'}</Button>}
      {!reusable && spool.lifecycle === 'active' && <Button renderIcon={Add} onClick={() => openMovement('consumption')}>Record consumption</Button>}
      <OverflowMenu aria-label="More spool actions" iconDescription="More spool actions" flipped>
        {!archived && hasFill && <OverflowMenuItem itemText={reusable ? 'Empty spool' : 'Finish spool'} onClick={() => setDialog('finish')} />}
        <OverflowMenuItem itemText="Correct stock" disabled={!material || !hasFill} onClick={() => openMovement('correction')} />
        <OverflowMenuItem itemText="Add identifier" onClick={() => setDialog('identifier')} />
        <OverflowMenuItem itemText="Edit spool" onClick={() => setDialog('edit')} />
        {!archived && <OverflowMenuItem itemText="Archive" disabled={!reusable && spool.remainingQuantity > 0} onClick={() => setDialog('archive')} />}
        {archived && canRestore && <OverflowMenuItem itemText="Restore" onClick={() => setDialog('restore')} />}
      </OverflowMenu>
    </>
  ) : undefined;

  const fillColumns: Column<SpoolFill>[] = [
    { key: 'fill', header: 'Fill #', sortValue: (fill) => fill.fillNumber, firstDirection: 'DESC', render: (fill) => `#${fill.fillNumber}` },
    {
      key: 'product', header: 'Product', sortValue: (fill) => fill.productName ?? '',
      render: (fill) => (
        <div className="mj-cell-stack">
          <span>{fill.productName ?? fill.manufacturer ?? 'No product recorded'}</span>
          {fill.productName && fill.manufacturer && <span className="mj-secondary">{fill.manufacturer}</span>}
          <span className="mj-secondary mj-show-narrow">{fill.materialName}</span>
        </div>
      ),
    },
    { key: 'material', header: 'Material', narrow: true, sortValue: (fill) => fill.materialName, render: (fill) => fill.materialName },
    { key: 'filled', header: 'Filled', narrow: true, sortValue: (fill) => fill.filledAt, firstDirection: 'DESC', render: (fill) => formatDateTime(fill.filledAt) },
    { key: 'closed', header: 'Closed', narrow: true, sortValue: (fill) => fill.closedAt, firstDirection: 'DESC', render: (fill) => formatDateTime(fill.closedAt) },
    { key: 'used', header: 'Used', sortValue: (fill) => fill.usedG, firstDirection: 'DESC', render: (fill) => formatGrams(fill.usedG) },
    {
      key: 'leftover', header: 'Leftover', sortValue: (fill) => fill.leftoverG, firstDirection: 'DESC',
      render: (fill) => (
        <div className="mj-cell-stack">
          <span>{formatGrams(fill.leftoverG)}</span>
          <span><OutcomeTag outcome={fill.leftoverOutcome} /></span>
        </div>
      ),
    },
    {
      key: 'tags', header: 'Tags', narrow: true, sortValue: (fill) => fill.identifiers.length,
      render: (fill) => fill.identifiers.length === 0 ? '0' : (
        <Toggletip>
          <ToggletipButton label={`Show the ${fill.identifiers.length} tags of fill ${fill.fillNumber}`}><span>{fill.identifiers.length}</span></ToggletipButton>
          <ToggletipContent>
            <ul>{fill.identifiers.map((item) => <li key={item.id}>{identifierLabel(item.kind)} <span className="mj-inline-mono">{item.value}</span></li>)}</ul>
          </ToggletipContent>
        </Toggletip>
      ),
    },
  ];

  const identifierColumns: Column<SpoolIdentifier>[] = [
    { key: 'kind', header: 'Kind', sortValue: (item) => item.kind, render: (item) => identifierLabel(item.kind) },
    { key: 'value', header: 'Value', sortValue: (item) => item.value, render: (item) => <span className="mj-inline-mono">{item.value}</span> },
    { key: 'added', header: 'Added', narrow: true, sortValue: (item) => item.addedAt, firstDirection: 'DESC', render: (item) => formatDateTime(item.addedAt) },
    ...(canManage ? [{
      key: 'actions', header: 'Actions',
      render: (item: SpoolIdentifier) => (
        <Button hasIconOnly kind="ghost" size="sm" renderIcon={TrashCan} iconDescription={`Remove ${identifierLabel(item.kind)} ${item.value}`} tooltipPosition="left" onClick={() => setRemoving(item)} />
      ),
    } satisfies Column<SpoolIdentifier>] : []),
  ];

  const archiveMessage = () => {
    const where = mount ? ` It is also removed from ${mount.machineName} (${mount.slotName}).` : '';
    return `The spool is hidden from mounting and keeps its ${formatGrams(spool.remainingQuantity)} on record. You can restore it later.${where}`;
  };

  return (
    <PageShell
      title={spool.displayId} titleAdornment={<><KindTag kind={spool.kind} /><LifecycleTag spool={spool} /></>} width="wide"
      description={[spool.label, material?.name, spoolTitle(spool)].filter(Boolean).join(' · ') || 'No filament loaded'}
      breadcrumbs={crumbs} actions={actions}
    >
      <div className="mj-stack">
        <Tile>
          <div className="mj-spool-remaining">
            {empty
              ? <InlineNotification kind="info" lowContrast hideCloseButton title="Needs refill" subtitle={`${spoolNameText(spool)} has no filament. Fill it with Change filament; earlier fills stay in the history below.`} />
              : <ProgressBar label="Remaining filament" value={spool.remainingQuantity} max={spool.initialNetWeightG} status={spool.lifecycle === 'active' && percent < 15 ? 'error' : 'active'} helperText={`${spoolRemainingText(spool)} · ${percent} %`} />}
            <dl className="mj-facts">
              <div><dt>Material</dt><dd>{material ? <CarbonLink as={Link} to={`/inventory/materials/${material.id}`}>{material.name}</CarbonLink> : '—'}</dd></div>
              <div>
                <dt>Product</dt>
                <dd className="mj-cell-stack">
                  <span>{spool.productName ?? spool.manufacturer ?? '—'}</span>
                  {spool.productName && spool.manufacturer && <span className="mj-secondary">{spool.manufacturer}</span>}
                </dd>
              </div>
              <div><dt>{reusable ? 'Current fill' : 'Fill'}</dt><dd>{hasFill && spool.filledAt ? `Fill ${spool.fillNumber} · since ${formatDate(spool.filledAt)}` : spool.fillNumber > 0 ? `None, last was fill ${spool.fillNumber}` : 'None yet'}</dd></div>
              <div><dt>Tare weight</dt><dd>{spool.tareWeightG != null ? formatGrams(spool.tareWeightG) : '—'}</dd></div>
              <div><dt>Location</dt><dd>{spool.storageLocation ?? '—'}</dd></div>
              <div>
                <dt>Mounted on</dt>
                <dd>{mount ? <CarbonLink as={Link} to={`/machines/${mount.machineId}?tab=printer`}>{mount.machineName} · {mount.slotName}</CarbonLink> : 'Not mounted'}</dd>
              </div>
              <div>
                <dt>Acquired</dt>
                <dd className="mj-cell-stack"><span>{formatDate(spool.acquiredOn)}</span>{spool.acquisitionReference && <span className="mj-secondary">{spool.acquisitionReference}</span>}</dd>
              </div>
              <div><dt>Avg. cost</dt><dd>{formatUnitCost(averageCost ?? null, 'g')}{spool.purchasePrice != null && <><br /><span className="mj-secondary">Paid {formatMoney(spool.purchasePrice)}</span></>}</dd></div>
            </dl>
            {spool.notes && <p className="mj-secondary">{spool.notes}</p>}
          </div>
        </Tile>
        <section className="mj-inventory-section" aria-labelledby="spool-identifiers-title">
          <h2 id="spool-identifiers-title" className="mj-section-title">Identifiers</h2>
          <DirectoryTable
            id="identifiers" label="Identifiers" columns={identifierColumns} rows={spool.identifiers} totalCount={spool.identifiers.length}
            searchText={(item) => `${identifierLabel(item.kind)} ${item.value}`} defaultSort={{ key: 'kind', direction: 'ASC' }}
            toolbarAction={canManage ? <Button kind="primary" size="lg" onClick={() => setDialog('identifier')}>Add identifier</Button> : undefined}
            empty={{ title: 'No identifiers', description: 'Add an NFC tag or barcode so the spool can be found by scanning.' }}
            pageSizes={[10, 25]}
          />
        </section>
        {(reusable || spool.fills.length > 0) && (
          <section className="mj-inventory-section" aria-labelledby="spool-fills-title">
            <h2 id="spool-fills-title" className="mj-section-title">Fill history</h2>
            <DirectoryTable
              id="fills" label="Fills" columns={fillColumns} rows={spool.fills} totalCount={spool.fills.length}
              searchText={(fill) => `${fill.fillNumber} ${fill.materialName} ${fill.manufacturer ?? ''} ${fill.productName ?? ''} ${fill.identifiers.map((item) => item.value).join(' ')}`}
              defaultSort={{ key: 'filled', direction: 'DESC' }}
              empty={{ title: 'No closed fills yet', description: 'When a fill is closed by a refill or by emptying the spool, it is kept here with its leftover and tags.' }}
              pageSizes={[10, 25]}
            />
          </section>
        )}
        <section className="mj-inventory-section" aria-labelledby="spool-ledger-title">
          <h2 id="spool-ledger-title" className="mj-section-title">Ledger</h2>
          <InventoryLedgerTable id="ledger" transactions={transactions} unit="g" showSpool={false} showFill />
        </section>
      </div>
      {material && <StockMovementModal open={dialog === 'movement'} onClose={close} mode={mode} material={material} spool={spool} />}
      <ChangeFilamentModal open={dialog === 'refill'} onClose={close} spool={spool} />
      <FinishSpoolModal open={dialog === 'finish'} onClose={close} spool={spool} />
      <IdentifierModal open={dialog === 'identifier'} onClose={close} spool={spool} />
      <SpoolFormModal open={dialog === 'edit'} onClose={close} spool={spool} />
      <DestructiveActionDialog
        open={dialog === 'archive'} title="Archive this spool?" confirmLabel="Archive" pending={changing} onClose={close}
        onConfirm={async () => { await setLifecycle(spool.id, 'archived'); store.notify({ kind: 'success', title: 'Spool archived', subtitle: spool.displayId }); close(); }}
      >
        <p>{archiveMessage()}</p>
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={dialog === 'restore'} title="Restore this spool?" confirmLabel="Restore" pending={changing} onClose={close}
        onConfirm={async () => { await setLifecycle(spool.id, restoreTarget); store.notify({ kind: 'success', title: 'Spool restored', subtitle: `${spool.displayId} is ${restoreTarget === 'empty' ? 'waiting for a refill' : 'active'}.` }); close(); }}
      >
        <p>The spool returns to the list as {restoreTarget === 'empty' ? 'needing a refill' : `loaded with ${formatGrams(spool.remainingQuantity)} on record`}.</p>
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={removing !== null} title="Remove identifier?" confirmLabel="Remove identifier" pending={removingPending} onClose={() => setRemoving(null)}
        onConfirm={async () => {
          if (!removing) return;
          await removeIdentifier(spool.id, removing.id);
          store.notify({ kind: 'success', title: 'Identifier removed', subtitle: `${identifierLabel(removing.kind)} from ${spool.displayId}` });
          setRemoving(null);
        }}
      >
        <p>{removing ? `${identifierLabel(removing.kind)} ${removing.value}` : 'The identifier'} no longer finds this spool when scanned.</p>
      </DestructiveActionDialog>
    </PageShell>
  );
}

export function SpoolDetailPage() {
  const { spoolId } = useParams();
  const store = useStore();
  const query = useSimulatedQuery((data): Data => {
    const spool = data.spools.find((item) => item.id === spoolId) ?? null;
    return {
      spool, material: spool ? data.materials.find((item) => item.id === spool.materialId) ?? null : null,
      transactions: data.transactions.filter((tx) => tx.spoolId === spoolId),
    };
  }, { spool: null, material: null, transactions: [] } as Data);
  if (!store.can('inventory.read')) return <PageShell title="Spool" breadcrumbs={crumbs} width="wide"><NoInventoryAccess /></PageShell>;
  if (query.status === 'success' && query.data.spool) return <SpoolDetail spool={query.data.spool} material={query.data.material} transactions={query.data.transactions} />;
  // Ledger entries keep the spool ID of a deleted spool.
  const deletedId = query.status === 'success' ? query.data.transactions.find((tx) => tx.spoolDisplayId)?.spoolDisplayId ?? null : null;
  const materialId = query.status === 'success' ? query.data.transactions[0]?.materialId : undefined;
  return (
    <PageShell title={query.status === 'success' ? (deletedId ? `${deletedId} (deleted)` : 'Spool not found') : 'Spool'} breadcrumbs={crumbs} width="wide">
      <QueryBoundary query={query} errorMessage="The spool could not be loaded.">
        {deletedId ? (
          <EmptyState
            title="This spool was deleted" description="Its usage history stays on the material."
            action={<Button kind="tertiary" as={Link} to={materialId ? `/inventory/materials/${materialId}` : '/inventory?tab=spools'}>{materialId ? 'Open the material' : 'Back to spools'}</Button>}
          />
        ) : (
          <EmptyState title="This spool does not exist" description="It may have been removed, or the link is incorrect." action={<Button kind="tertiary" as={Link} to="/inventory?tab=spools">Back to spools</Button>} />
        )}
      </QueryBoundary>
    </PageShell>
  );
}
