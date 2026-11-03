import { useState } from 'react';
import { Button, InlineNotification, Link as CarbonLink, OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { deleteFilamentSpoolIdentifier } from '../../api/generated/filament-spools/filament-spools';
import type { FilamentSpool, FilamentSpoolIdentifier, InventoryTransaction } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { Fact, FactsGrid, FactTiles } from '../../app/components/Facts';
import { formatDate } from '../../app/dateTime';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { StackCard } from '../../app/components/CardList';
import { ArticleMeta } from './components/ArticlePanel';
import { formatGrams, NoInventoryAccess } from './components/inventoryShared';
import { InventoryLedgerTable } from './components/InventoryLedgerTable';
import { SpoolDialogs, spoolActionsFor, useSpoolPermissions, type SpoolDialog } from './components/spoolActions';
import { SpoolTags } from './components/SpoolPanel';
import {
  identifierLabel,
  initialOf,
  isRetired,
  MountLink,
  remainingOf,
  retireOutcomeText,
  SpoolRemaining,
  spoolPercent,
} from './components/spoolShared';
import { DeleteLedgerEntryModal } from './dialogs/DeleteLedgerEntryModal';
import { materialQuery, spoolQuery } from './queries';
import { DirectoryTable, type Column } from './shared/DirectoryTable';
import { formatDateTime } from './shared/format';
import { inventorySectionPath, machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { useNotify } from './shared/toasts';
import { useCan } from './shared/useCan';
import { allSpoolTransactionsQuery, spoolErrorMessage, useRefreshInventory } from './spoolData';
import './styles/inventory.scss';

const crumbs = [
  { label: 'Workshop', to: machineLogbookPaths.home() },
  { label: 'Inventory', to: machineLogbookPaths.inventory() },
  { label: 'Spools', to: machineLogbookPaths.inventory('spools') },
];

function SpoolDetail({ spool }: { spool: FilamentSpool }) {
  const can = useCan();
  const notify = useNotify();
  const navigate = useNavigate();
  const refresh = useRefreshInventory();
  const allowed = useSpoolPermissions();
  const [dialog, setDialog] = useState<SpoolDialog | null>(null);
  const [removing, setRemoving] = useState<FilamentSpoolIdentifier | null>(null);
  const [deleting, setDeleting] = useState<InventoryTransaction | null>(null);
  const retired = isRetired(spool);
  const material = useQuery(materialQuery(spool.materialId));
  const ledger = useQuery(allSpoolTransactionsQuery(spool.id));
  const removeIdentifier = useMutation({
    mutationFn: (identifier: FilamentSpoolIdentifier) => deleteFilamentSpoolIdentifier(spool.id, identifier.id),
  });
  const items = spoolActionsFor(spool, allowed);
  const primary = items.find((item) => item.id === (retired ? 'restore' : 'weigh'));
  const menu = items.filter((item) => item !== primary);

  const actions =
    items.length > 0 ? (
      <>
        {primary && (
          <Button kind={retired ? 'primary' : 'secondary'} onClick={() => setDialog(primary.id)}>
            {primary.label}
          </Button>
        )}
        {menu.length > 0 && (
          <OverflowMenu aria-label="More spool actions" iconDescription="More spool actions" flipped>
            {menu.map((item) => (
              <OverflowMenuItem
                key={item.id}
                itemText={item.label}
                isDelete={item.danger}
                hasDivider={item.danger}
                onClick={() => setDialog(item.id)}
              />
            ))}
          </OverflowMenu>
        )}
      </>
    ) : undefined;

  const identifierColumns: Column<FilamentSpoolIdentifier>[] = [
    { key: 'kind', header: 'Kind', sortValue: (item) => item.kind, render: (item) => identifierLabel(item.kind) },
    {
      key: 'value',
      header: 'Value',
      sortValue: (item) => item.value,
      render: (item) => <span className="inv-mono">{item.value}</span>,
    },
    {
      key: 'added',
      header: 'Added',
      narrow: true,
      sortValue: (item) => item.createdAt,
      firstDirection: 'DESC',
      render: (item) => formatDateTime(item.createdAt),
    },
    ...(allowed.edit && !retired
      ? [
          {
            key: 'actions',
            header: 'Actions',
            hiddenHeader: true,
            className: 'inv-actions-column',
            render: (item: FilamentSpoolIdentifier) => (
              <Button
                hasIconOnly
                kind="ghost"
                size="sm"
                renderIcon={TrashCan}
                iconDescription={`Remove ${identifierLabel(item.kind)} ${item.value}`}
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

  return (
    <PageShell
      title={spool.displayId}
      titleAdornment={<SpoolTags spool={spool} size="md" />}
      width="wide"
      breadcrumbs={retired ? [crumbs[0], crumbs[1], { label: 'Recycle bin', to: inventorySectionPath('bin') }] : crumbs}
      actions={actions}
    >
      <div className="mj-stack">
        {retired && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Retired"
            subtitle={`${[
              retireOutcomeText(spool),
              spool.archivedAt ? formatDate(spool.archivedAt) : null,
              spool.retiredByName ? `by ${spool.retiredByName}` : null,
            ]
              .filter(Boolean)
              .join(' · ')}. The spool is in the inventory recycle bin.`}
          />
        )}
        <FactTiles
          label="Spool figures"
          items={[
            {
              label: 'Remaining',
              value: retired ? 'Retired' : <SpoolRemaining spool={spool} />,
              helper: retired ? retireOutcomeText(spool) : `${spoolPercent(spool)} % of the initial net weight`,
            },
            {
              label: 'Used',
              value: formatGrams(Math.max(0, initialOf(spool) - remainingOf(spool))),
              helper: `of ${formatGrams(initialOf(spool))} initially`,
            },
            {
              label: 'Where',
              value: spool.mountedOn ? <MountLink mount={spool.mountedOn} /> : spool.storageLocation || '—',
              helper: retired ? 'no longer in stock' : spool.mounted ? 'mounted' : 'in storage',
            },
            {
              label: 'Article',
              value: (
                <CarbonLink as={Link} to={machineLogbookPaths.material(spool.materialId)}>
                  {spool.materialDisplayId}
                </CarbonLink>
              ),
              helper: <ArticleMeta material={spool} />,
            },
          ]}
        />
        <div className="inv-article-layout">
          <div className="mj-stack">
            <section className="mj-stack" aria-labelledby="spool-ledger-title">
              <h2 id="spool-ledger-title" className="inv-section-title">
                Bookings <span className="inv-count">{ledger.data?.length ?? ''}</span>
              </h2>
              <QueryBoundary query={ledger} errorMessage="The bookings could not be loaded.">
                {(transactions) => (
                  <InventoryLedgerTable
                    id="ledger"
                    transactions={transactions}
                    unit="g"
                    showSpool={false}
                    onDelete={can('inventory.ledger.delete') && material.data ? setDeleting : undefined}
                  />
                )}
              </QueryBoundary>
            </section>
            <section className="mj-stack" aria-labelledby="spool-identifiers-title">
              <h2 id="spool-identifiers-title" className="inv-section-title">
                Identifiers <span className="inv-count">{spool.identifiers.length}</span>
              </h2>
              <DirectoryTable
                id="identifiers"
                label="Identifiers"
                columns={identifierColumns}
                rows={spool.identifiers}
                totalCount={spool.identifiers.length}
                searchable={false}
                searchText={(item) => `${identifierLabel(item.kind)} ${item.value}`}
                defaultSort={{ key: 'kind', direction: 'ASC' }}
                toolbarAction={
                  allowed.edit && !retired ? (
                    <Button kind="ghost" onClick={() => setDialog('identifier')}>
                      Add identifier
                    </Button>
                  ) : undefined
                }
                empty={{
                  title: 'No identifiers',
                  description: 'Add the RFID tag, a barcode or QR code so the spool is found by scanning.',
                }}
                pageSizes={[10, 25]}
              />
            </section>
          </div>
          <div className="mj-stack">
            <StackCard title="Facts">
              <FactsGrid columns={2}>
                <Fact label="Label">{spool.displayId}</Fact>
                <Fact label="Initial net weight">{formatGrams(initialOf(spool))}</Fact>
                <Fact label="Tare weight">{spool.tareWeightG != null ? formatGrams(spool.tareWeightG) : '—'}</Fact>
                <Fact label="Storage location">{spool.storageLocation || '—'}</Fact>
                <Fact label="Acquired" helper={spool.acquisitionReference ?? undefined}>
                  {spool.acquiredOn ? formatDate(spool.acquiredOn) : '—'}
                </Fact>
                <Fact label="Registered">{formatDate(spool.createdAt)}</Fact>
              </FactsGrid>
            </StackCard>
            <StackCard title="Notes">
              <p className={spool.notes ? 'inv-notes' : 'mj-secondary'}>{spool.notes || 'No notes.'}</p>
            </StackCard>
          </div>
        </div>
      </div>
      <SpoolDialogs
        spool={spool}
        dialog={dialog}
        onClose={() => setDialog(null)}
        onGone={dialog === 'purge' ? () => navigate(inventorySectionPath('bin')) : undefined}
      />
      {deleting && material.data && (
        <DeleteLedgerEntryModal transaction={deleting} material={material.data} onClose={() => setDeleting(null)} />
      )}
      <DestructiveActionDialog
        open={removing !== null}
        title="Remove identifier?"
        fate="permanent"
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
  // A purged spool answers 404, like a link that never was valid; its bookings stay on the article's ledger.
  if (query.error instanceof ApiError && query.error.status === 404) {
    return (
      <PageShell title="Spool not found" breadcrumbs={crumbs} width="wide">
        <EmptyState
          title="This spool does not exist"
          description="It may have been deleted permanently, or the link is incorrect. Its bookings stay on the article's ledger."
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
