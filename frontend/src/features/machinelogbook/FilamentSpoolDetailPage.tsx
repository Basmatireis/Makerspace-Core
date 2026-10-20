import { useState } from 'react';
import {
  Button,
  InlineNotification,
  Link as CarbonLink,
  OverflowMenu,
  OverflowMenuItem,
  ProgressBar,
  Tile,
  Toggletip,
  ToggletipButton,
  ToggletipContent,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import {
  deleteFilamentSpoolIdentifier,
  updateFilamentSpool,
} from '../../api/generated/filament-spools/filament-spools';
import type { FilamentSpool, FilamentSpoolFill, FilamentSpoolIdentifier } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { formatDate } from '../../app/dateTime';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { formatGrams, formatUnitCost, materialUnitCost, NoInventoryAccess } from './components/inventoryShared';
import { InventoryLedgerTable } from './components/InventoryLedgerTable';
import {
  hasOpenFill,
  identifierLabel,
  initialOf,
  KindTag,
  MountLink,
  needsRefill,
  OutcomeTag,
  remainingOf,
  removedFromText,
  spoolNameText,
  spoolPercent,
  spoolRemainingText,
  spoolTitle,
  StatusTag,
  toNumber,
} from './components/spoolShared';
import { ChangeFilamentModal } from './dialogs/ChangeFilamentModal';
import { FinishSpoolModal } from './dialogs/FinishSpoolModal';
import { IdentifierModal } from './dialogs/IdentifierModal';
import { SpoolFormModal } from './dialogs/SpoolFormModal';
import { StockMovementModal, type MovementMode } from './dialogs/StockMovementModal';
import { materialQuery, spoolQuery } from './queries';
import { DirectoryTable, type Column } from './shared/DirectoryTable';
import { formatDateTime } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { useNotify } from './shared/toasts';
import { useCan } from './shared/useCan';
import { allSpoolTransactionsQuery, spoolErrorMessage, spoolUpdateBody, useRefreshInventory } from './spoolData';

const crumbs = [
  { label: 'Workshop', to: machineLogbookPaths.overview() },
  { label: 'Inventory', to: machineLogbookPaths.inventory() },
  { label: 'Spools', to: machineLogbookPaths.inventory('spools') },
];
type Dialog = 'movement' | 'identifier' | 'edit' | 'finish' | 'refill' | 'archive' | 'restore' | null;

function SpoolDetail({ spool }: { spool: FilamentSpool }) {
  const can = useCan();
  const notify = useNotify();
  const refresh = useRefreshInventory();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [mode, setMode] = useState<MovementMode>('consumption');
  const [removing, setRemoving] = useState<FilamentSpoolIdentifier | null>(null);
  const close = () => setDialog(null);
  // Descriptive changes need filament_spools.manage; anything that moves stock also needs inventory.manage.
  const canManage = can('filament_spools.manage');
  const canMove = can('inventory.manage');
  const canRefill = canManage && canMove;
  const material =
    useQuery({ ...materialQuery(spool.materialId ?? ''), enabled: Boolean(spool.materialId) }).data ?? null;
  const ledger = useQuery(allSpoolTransactionsQuery(spool.id));
  const lifecycle = useMutation({
    mutationFn: (next: 'active' | 'archived') =>
      updateFilamentSpool(spool.id, spoolUpdateBody(spool, { lifecycle: next })),
  });
  const removeIdentifier = useMutation({
    mutationFn: (identifier: FilamentSpoolIdentifier) => deleteFilamentSpoolIdentifier(spool.id, identifier.id),
  });
  const openMovement = (next: MovementMode) => {
    setMode(next);
    setDialog('movement');
  };
  const percent = spoolPercent(spool);
  const reusable = spool.kind === 'reusable';
  const empty = needsRefill(spool);
  const archived = spool.status === 'archived';
  const hasFill = hasOpenFill(spool);
  const restoreTarget = !hasFill ? 'empty' : 'active';
  const canRestore = reusable || hasFill;
  const materialNames = new Map<string, string>([
    ...(spool.fills ?? []).map((fill) => [fill.materialId, fill.materialName] as const),
    ...(spool.materialId && spool.materialName ? [[spool.materialId, spool.materialName] as const] : []),
  ]);

  const overflow = [
    canRefill && !archived && hasFill && (
      <OverflowMenuItem
        key="finish"
        itemText={reusable ? 'Empty spool' : 'Finish spool'}
        onClick={() => setDialog('finish')}
      />
    ),
    canMove && !archived && (
      <OverflowMenuItem
        key="correct"
        itemText="Correct stock"
        disabled={!material || !hasFill}
        onClick={() => openMovement('correction')}
      />
    ),
    canManage && hasFill && (
      <OverflowMenuItem key="identifier" itemText="Add identifier" onClick={() => setDialog('identifier')} />
    ),
    canManage && <OverflowMenuItem key="edit" itemText="Edit spool" onClick={() => setDialog('edit')} />,
    canManage && !archived && (
      <OverflowMenuItem
        key="archive"
        itemText="Archive"
        disabled={remainingOf(spool) > 0}
        onClick={() => setDialog('archive')}
      />
    ),
    canManage && archived && canRestore && (
      <OverflowMenuItem key="restore" itemText="Restore" onClick={() => setDialog('restore')} />
    ),
  ].filter(Boolean);
  const showRefill = canRefill && reusable && !archived;
  const showConsume = canMove && !reusable && !archived;
  const actions =
    showRefill || showConsume || overflow.length > 0 ? (
      <>
        {showRefill && (
          <Button renderIcon={Add} onClick={() => setDialog('refill')}>
            {empty ? 'Fill spool' : 'Change filament'}
          </Button>
        )}
        {showConsume && (
          <Button renderIcon={Add} disabled={!material} onClick={() => openMovement('consumption')}>
            Record consumption
          </Button>
        )}
        {overflow.length > 0 && (
          <OverflowMenu aria-label="More spool actions" iconDescription="More spool actions" flipped>
            {overflow}
          </OverflowMenu>
        )}
      </>
    ) : undefined;

  const fillColumns: Column<FilamentSpoolFill>[] = [
    {
      key: 'fill',
      header: 'Fill #',
      sortValue: (fill) => fill.fillNumber,
      firstDirection: 'DESC',
      render: (fill) => `#${fill.fillNumber}`,
    },
    {
      key: 'product',
      header: 'Product',
      sortValue: (fill) => fill.productName ?? '',
      render: (fill) => (
        <div className="mj-cell-stack">
          <span>{fill.productName ?? fill.manufacturer ?? 'No product recorded'}</span>
          {fill.productName && fill.manufacturer && <span className="mj-secondary">{fill.manufacturer}</span>}
          <span className="mj-secondary mj-show-narrow">{fill.materialName}</span>
        </div>
      ),
    },
    {
      key: 'material',
      header: 'Material',
      narrow: true,
      sortValue: (fill) => fill.materialName,
      render: (fill) => fill.materialName,
    },
    {
      key: 'filled',
      header: 'Filled',
      narrow: true,
      sortValue: (fill) => fill.filledAt,
      firstDirection: 'DESC',
      render: (fill) => formatDateTime(fill.filledAt),
    },
    {
      key: 'closed',
      header: 'Closed',
      narrow: true,
      sortValue: (fill) => fill.closedAt,
      firstDirection: 'DESC',
      render: (fill) => formatDateTime(fill.closedAt),
    },
    {
      key: 'used',
      header: 'Used',
      sortValue: (fill) => toNumber(fill.usedG),
      firstDirection: 'DESC',
      render: (fill) => formatGrams(fill.usedG),
    },
    {
      key: 'leftover',
      header: 'Leftover',
      sortValue: (fill) => toNumber(fill.leftoverG),
      firstDirection: 'DESC',
      render: (fill) => (
        <div className="mj-cell-stack">
          <span>{formatGrams(fill.leftoverG)}</span>
          <span>
            <OutcomeTag outcome={fill.leftoverOutcome} />
          </span>
        </div>
      ),
    },
    {
      key: 'tags',
      header: 'Tags',
      narrow: true,
      sortValue: (fill) => fill.identifiers.length,
      render: (fill) =>
        fill.identifiers.length === 0 ? (
          '0'
        ) : (
          <Toggletip>
            <ToggletipButton label={`Show the ${fill.identifiers.length} tags of fill ${fill.fillNumber}`}>
              <span>{fill.identifiers.length}</span>
            </ToggletipButton>
            <ToggletipContent>
              <ul>
                {fill.identifiers.map((item) => (
                  <li key={item.id}>
                    {identifierLabel(item.kind)} <span className="mj-inline-mono">{item.value}</span>
                  </li>
                ))}
              </ul>
            </ToggletipContent>
          </Toggletip>
        ),
    },
  ];

  const identifierColumns: Column<FilamentSpoolIdentifier>[] = [
    { key: 'kind', header: 'Kind', sortValue: (item) => item.kind, render: (item) => identifierLabel(item.kind) },
    {
      key: 'value',
      header: 'Value',
      sortValue: (item) => item.value,
      render: (item) => <span className="mj-inline-mono">{item.value}</span>,
    },
    {
      key: 'added',
      header: 'Added',
      narrow: true,
      sortValue: (item) => item.createdAt,
      firstDirection: 'DESC',
      render: (item) => formatDateTime(item.createdAt),
    },
    ...(canManage
      ? [
          {
            key: 'actions',
            header: 'Actions',
            render: (item: FilamentSpoolIdentifier) => (
              <Button
                hasIconOnly
                kind="ghost"
                size="sm"
                renderIcon={TrashCan}
                iconDescription={`Remove ${identifierLabel(item.kind)} ${item.value}`}
                tooltipPosition="left"
                onClick={() => {
                  removeIdentifier.reset();
                  setRemoving(item);
                }}
              />
            ),
          } satisfies Column<FilamentSpoolIdentifier>,
        ]
      : []),
  ];

  const archiveMessage = () => {
    const where = removedFromText(spool);
    return `The spool is hidden from mounting and from new fills. You can restore it later.${where}`;
  };

  const changeLifecycle = async (next: 'active' | 'archived') => {
    try {
      await lifecycle.mutateAsync(next);
    } catch {
      await refresh();
      return;
    }
    await refresh();
    notify(
      next === 'archived'
        ? { kind: 'success', title: 'Spool archived', subtitle: spool.displayId }
        : {
            kind: 'success',
            title: 'Spool restored',
            subtitle: `${spool.displayId} is ${restoreTarget === 'empty' ? 'waiting for a refill' : 'active'}.`,
          },
    );
    close();
  };

  return (
    <PageShell
      title={spool.displayId}
      titleAdornment={
        <>
          <KindTag kind={spool.kind} />
          <StatusTag spool={spool} />
        </>
      }
      width="wide"
      description={
        [spool.label, spool.materialName, spoolTitle(spool)].filter(Boolean).join(' · ') || 'No filament loaded'
      }
      breadcrumbs={crumbs}
      actions={actions}
    >
      <div className="mj-stack">
        <Tile>
          <div className="mj-spool-remaining">
            {empty ? (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Needs refill"
                subtitle={`${spoolNameText(spool)} has no filament. Fill it with Change filament; earlier fills stay in the history below.`}
              />
            ) : (
              <ProgressBar
                label="Remaining filament"
                value={remainingOf(spool)}
                max={initialOf(spool)}
                status={!archived && percent < 15 ? 'error' : 'active'}
                helperText={`${spoolRemainingText(spool)} · ${percent} %`}
              />
            )}
            <dl className="mj-facts">
              <div>
                <dt>Material</dt>
                <dd>
                  {spool.materialId && spool.materialName ? (
                    <CarbonLink as={Link} to={machineLogbookPaths.material(spool.materialId)}>
                      {spool.materialName}
                    </CarbonLink>
                  ) : (
                    '—'
                  )}
                </dd>
              </div>
              <div>
                <dt>Product</dt>
                <dd className="mj-cell-stack">
                  <span>{spool.productName ?? spool.manufacturer ?? '—'}</span>
                  {spool.productName && spool.manufacturer && (
                    <span className="mj-secondary">{spool.manufacturer}</span>
                  )}
                </dd>
              </div>
              <div>
                <dt>{reusable ? 'Current fill' : 'Fill'}</dt>
                <dd>
                  {hasFill && spool.filledAt
                    ? `Fill ${spool.fillNumber} · since ${formatDate(spool.filledAt)}`
                    : spool.fillNumber > 0 && (spool.fills?.length ?? 0) > 0
                      ? `None, last was fill ${spool.fillNumber}`
                      : 'None yet'}
                </dd>
              </div>
              <div>
                <dt>Tare weight</dt>
                <dd>{spool.tareWeightG != null ? formatGrams(spool.tareWeightG) : '—'}</dd>
              </div>
              <div>
                <dt>Location</dt>
                <dd>{spool.storageLocation ?? '—'}</dd>
              </div>
              <div>
                <dt>Mounted on</dt>
                <dd>
                  {spool.mountedOn ? <MountLink mount={spool.mountedOn} /> : spool.mounted ? 'Mounted' : 'Not mounted'}
                </dd>
              </div>
              <div>
                <dt>Acquired</dt>
                <dd className="mj-cell-stack">
                  <span>{spool.acquiredOn ? formatDate(spool.acquiredOn) : '—'}</span>
                  {spool.acquisitionReference && <span className="mj-secondary">{spool.acquisitionReference}</span>}
                </dd>
              </div>
              <div>
                <dt>Avg. cost</dt>
                <dd>{formatUnitCost(material ? materialUnitCost(material) : null, 'g')}</dd>
              </div>
            </dl>
            {spool.notes && <p className="mj-secondary">{spool.notes}</p>}
          </div>
        </Tile>
        <section className="mj-inventory-section" aria-labelledby="spool-identifiers-title">
          <h2 id="spool-identifiers-title" className="mj-section-title">
            Identifiers
          </h2>
          <DirectoryTable
            id="identifiers"
            label="Identifiers"
            columns={identifierColumns}
            rows={spool.identifiers}
            totalCount={spool.identifiers.length}
            searchText={(item) => `${identifierLabel(item.kind)} ${item.value}`}
            defaultSort={{ key: 'kind', direction: 'ASC' }}
            toolbarAction={
              canManage && hasFill ? (
                <Button kind="primary" size="lg" onClick={() => setDialog('identifier')}>
                  Add identifier
                </Button>
              ) : undefined
            }
            empty={{
              title: 'No identifiers',
              description: 'Add an NFC tag or barcode so the spool can be found by scanning.',
            }}
            pageSizes={[10, 25]}
          />
        </section>
        {(reusable || (spool.fills?.length ?? 0) > 0) && (
          <section className="mj-inventory-section" aria-labelledby="spool-fills-title">
            <h2 id="spool-fills-title" className="mj-section-title">
              Fill history
            </h2>
            <DirectoryTable
              id="fills"
              label="Fills"
              columns={fillColumns}
              rows={spool.fills ?? []}
              totalCount={spool.fills?.length ?? 0}
              searchText={(fill) =>
                `${fill.fillNumber} ${fill.materialName} ${fill.manufacturer ?? ''} ${fill.productName ?? ''} ${fill.identifiers.map((item) => item.value).join(' ')}`
              }
              defaultSort={{ key: 'filled', direction: 'DESC' }}
              empty={{
                title: 'No closed fills yet',
                description:
                  'When a fill is closed by a refill or by emptying the spool, it is kept here with its leftover and tags.',
              }}
              pageSizes={[10, 25]}
            />
          </section>
        )}
        <section className="mj-inventory-section" aria-labelledby="spool-ledger-title">
          <h2 id="spool-ledger-title" className="mj-section-title">
            Ledger
          </h2>
          <QueryBoundary query={ledger} errorMessage="The ledger could not be loaded.">
            {(transactions) => (
              <InventoryLedgerTable
                id="ledger"
                transactions={transactions}
                unit="g"
                showSpool={false}
                showFill
                materialNames={materialNames}
              />
            )}
          </QueryBoundary>
        </section>
      </div>
      {material && (
        <StockMovementModal
          open={dialog === 'movement'}
          onClose={close}
          mode={mode}
          material={material}
          spool={spool}
        />
      )}
      {canRefill && <ChangeFilamentModal open={dialog === 'refill'} onClose={close} spool={spool} />}
      {canRefill && <FinishSpoolModal open={dialog === 'finish'} onClose={close} spool={spool} />}
      {canManage && <IdentifierModal open={dialog === 'identifier'} onClose={close} spool={spool} />}
      {canManage && <SpoolFormModal open={dialog === 'edit'} onClose={close} spool={spool} />}
      <DestructiveActionDialog
        open={dialog === 'archive'}
        title="Archive this spool?"
        confirmLabel="Archive"
        pending={lifecycle.isPending}
        onClose={close}
        error={lifecycle.isError ? spoolErrorMessage(lifecycle.error) : undefined}
        onConfirm={() => {
          void changeLifecycle('archived');
        }}
      >
        <p>{archiveMessage()}</p>
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={dialog === 'restore'}
        title="Restore this spool?"
        confirmLabel="Restore"
        pending={lifecycle.isPending}
        onClose={close}
        error={lifecycle.isError ? spoolErrorMessage(lifecycle.error) : undefined}
        onConfirm={() => {
          void changeLifecycle('active');
        }}
      >
        <p>
          The spool returns to the list as{' '}
          {restoreTarget === 'empty' ? 'needing a refill' : `loaded with ${formatGrams(remainingOf(spool))} on record`}.
        </p>
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={removing !== null}
        title="Remove identifier?"
        confirmLabel="Remove identifier"
        pending={removeIdentifier.isPending}
        onClose={() => setRemoving(null)}
        error={removeIdentifier.isError ? spoolErrorMessage(removeIdentifier.error) : undefined}
        onConfirm={async () => {
          if (!removing) return;
          try {
            await removeIdentifier.mutateAsync(removing);
          } catch {
            await refresh();
            return;
          }
          await refresh();
          notify({
            kind: 'success',
            title: 'Identifier removed',
            subtitle: `${identifierLabel(removing.kind)} from ${spool.displayId}`,
          });
          setRemoving(null);
        }}
      >
        <p>
          {removing ? `${identifierLabel(removing.kind)} ${removing.value}` : 'The identifier'} no longer finds this
          spool when scanned.
        </p>
      </DestructiveActionDialog>
    </PageShell>
  );
}

export function FilamentSpoolDetailPage() {
  const { spoolId = '' } = useParams();
  const can = useCan();
  const query = useQuery({ ...spoolQuery(spoolId), enabled: can('inventory.read') });
  if (!can('inventory.read'))
    return (
      <PageShell title="Spool" breadcrumbs={crumbs} width="wide">
        <NoInventoryAccess />
      </PageShell>
    );
  if (query.status === 'success') return <SpoolDetail spool={query.data} />;
  // A spool that cleanup deleted answers 404, like a link that never was valid; its usage history stays on the material.
  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <PageShell title="Spool not found" breadcrumbs={crumbs} width="wide">
        <EmptyState
          title="This spool does not exist"
          description="It may have been deleted by a cleanup, or the link is incorrect. Usage history of a deleted spool stays on its material."
          action={
            <Button kind="tertiary" as={Link} to={machineLogbookPaths.inventory('spools')}>
              Back to spools
            </Button>
          }
        />
      </PageShell>
    );
  }
  return (
    <PageShell title="Spool" breadcrumbs={crumbs} width="wide">
      <QueryBoundary query={query} errorMessage="The spool could not be loaded.">
        {null}
      </QueryBoundary>
    </PageShell>
  );
}
