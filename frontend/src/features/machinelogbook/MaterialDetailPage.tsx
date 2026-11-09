import { useState } from 'react';
import { ActionableNotification, Button, Link as CarbonLink, OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { Add, Edit } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { FilamentSpool, Material } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { StackCard } from '../../app/components/CardList';
import { Fact, FactsGrid, FactTiles } from '../../app/components/Facts';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { ArticleDialogs, useArticlePermissions, type ArticleDialog } from './components/articleActions';
import { ArticleTags, minimumHelper, stockHelper } from './components/ArticlePanel';
import {
  ColorSwatch,
  formatQuantity,
  formatRate,
  formatUnitCost,
  isFilament,
  kindNames,
  materialUnitCost,
  NoInventoryAccess,
  priceSourceLabel,
} from './components/inventoryShared';
import { articleUnitLabel } from './units';
import { InventoryLedgerTable } from './components/InventoryLedgerTable';
import { MountLink, nfcTagOf, remainingOf, SpoolRemaining } from './components/spoolShared';
import { SpoolDialogs, spoolActionsFor, useSpoolPermissions, type SpoolDialog } from './components/spoolActions';
import { allTransactionsQuery } from './inventoryQueries';
import { materialQuery } from './queries';
import { attentionDirectoryColumn, DirectoryTable, type Column } from './shared/DirectoryTable';
import { formatMoney } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { useCan } from './shared/useCan';
import { allSpoolsQuery } from './spoolData';
import './styles/inventory.scss';

const crumbs = [
  { label: 'Workshop', to: machineLogbookPaths.home() },
  { label: 'Inventory', to: machineLogbookPaths.inventory() },
];

function SpoolsSection({ material, onRegister }: { material: Material; onRegister?: () => void }) {
  const allowedSpool = useSpoolPermissions();
  const query = useQuery(allSpoolsQuery({ materialId: material.id, lifecycle: 'active' }));
  const [action, setAction] = useState<{ spool: FilamentSpool; dialog: SpoolDialog } | null>(null);
  const columns: Column<FilamentSpool>[] = [
    {
      key: 'spool',
      header: 'Spool',
      sortValue: (spool) => spool.displayId,
      render: (spool) => (
        <CarbonLink as={Link} to={machineLogbookPaths.spool(spool.id)} className="inv-mono">
          {spool.displayId}
        </CarbonLink>
      ),
    },
    {
      key: 'remaining',
      header: 'Remaining',
      sortValue: (spool) => remainingOf(spool),
      firstDirection: 'DESC',
      render: (spool) => <SpoolRemaining spool={spool} />,
    },
    {
      key: 'where',
      header: 'Where',
      narrow: true,
      sortValue: (spool) => spool.mountedOn?.machineName ?? spool.storageLocation ?? '',
      render: (spool) => (spool.mountedOn ? <MountLink mount={spool.mountedOn} /> : spool.storageLocation || '—'),
    },
    {
      key: 'tag',
      header: 'Tag',
      narrow: true,
      render: (spool) => <span className="inv-mono">{nfcTagOf(spool) ?? '—'}</span>,
    },
    attentionDirectoryColumn<FilamentSpool>((spool) => spool.attention),
    {
      key: 'actions',
      header: 'Actions',
      hiddenHeader: true,
      className: 'inv-actions-column',
      render: (spool) => {
        const items = spoolActionsFor(spool, allowedSpool);
        return items.length > 0 ? (
          <OverflowMenu size="sm" aria-label={`Actions of ${spool.displayId}`} iconDescription="Spool actions" flipped>
            {items.map((item) => (
              <OverflowMenuItem
                key={item.id}
                itemText={item.label}
                isDelete={item.danger}
                hasDivider={item.danger}
                onClick={() => setAction({ spool, dialog: item.id })}
              />
            ))}
          </OverflowMenu>
        ) : null;
      },
    },
  ];
  return (
    <section className="mj-stack" aria-labelledby="article-spools-title">
      <h2 id="article-spools-title" className="inv-section-title">
        Spools <span className="inv-count">{query.data?.length ?? ''}</span>
      </h2>
      <QueryBoundary query={query} errorMessage="The spools could not be loaded.">
        {(spools) => (
          <DirectoryTable
            id="article-spools"
            label="Spools"
            columns={columns}
            rows={spools}
            totalCount={spools.length}
            searchable={false}
            searchText={(spool) => spool.displayId}
            defaultSort={{ key: 'spool', direction: 'ASC' }}
            toolbarAction={
              onRegister ? (
                <Button kind="ghost" renderIcon={Add} onClick={onRegister}>
                  Register spool
                </Button>
              ) : undefined
            }
            empty={{
              title: 'No active spools',
              description:
                Number(material.unassignedQuantity) > 0
                  ? 'Register a spool from loose stock when one is opened.'
                  : 'Receive filament on new spools to track what is left on each.',
            }}
          />
        )}
      </QueryBoundary>
      {action && <SpoolDialogs spool={action.spool} dialog={action.dialog} onClose={() => setAction(null)} />}
    </section>
  );
}

function MaterialDetail({ material }: { material: Material }) {
  const navigate = useNavigate();
  const can = useCan();
  const allowed = useArticlePermissions();
  const [dialog, setDialog] = useState<ArticleDialog | null>(null);
  const ledger = useQuery(allTransactionsQuery(material.id));
  const spools = useQuery({
    ...allSpoolsQuery({ materialId: material.id, lifecycle: 'active' }),
    enabled: isFilament(material),
  });
  const filament = isFilament(material);
  const unitCost = materialUnitCost(material);
  const loose = Number(material.unassignedQuantity);
  const listTab = 'articles';

  const actions = (
    <>
      {allowed.manage && (
        <Button kind="secondary" renderIcon={Edit} onClick={() => setDialog({ name: 'edit' })}>
          Edit article
        </Button>
      )}
      {allowed.receive && (
        <Button renderIcon={Add} onClick={() => setDialog({ name: 'receive' })}>
          Receive stock
        </Button>
      )}
      {(allowed.register || allowed.consume || allowed.correct || allowed.delete) && (
        <OverflowMenu aria-label="More article actions" iconDescription="More article actions" flipped>
          {filament && allowed.register && (
            <OverflowMenuItem itemText="Register spool" onClick={() => setDialog({ name: 'register' })} />
          )}
          {allowed.consume && (
            <OverflowMenuItem
              itemText="Record consumption"
              disabled={loose <= 0}
              onClick={() => setDialog({ name: 'movement', mode: 'consumption' })}
            />
          )}
          {allowed.correct && (
            <OverflowMenuItem
              itemText="Correct stock"
              onClick={() => setDialog({ name: 'movement', mode: 'correction' })}
            />
          )}
          {allowed.correct && (
            <OverflowMenuItem
              itemText="Record disposal"
              disabled={loose <= 0}
              onClick={() => setDialog({ name: 'movement', mode: 'disposal' })}
            />
          )}
          {allowed.correct && (
            <OverflowMenuItem
              itemText="Mark as empty"
              disabled={Number(material.quantity) <= 0 || Number(material.assignedQuantity) > 0}
              onClick={() => setDialog({ name: 'empty' })}
            />
          )}
          {allowed.delete && (
            <OverflowMenuItem
              itemText="Delete article"
              isDelete
              hasDivider
              onClick={() => setDialog({ name: 'delete' })}
            />
          )}
        </OverflowMenu>
      )}
    </>
  );

  return (
    <PageShell
      title={material.name}
      titleAdornment={<ArticleTags material={material} size="md" />}
      width="wide"
      breadcrumbs={[
        crumbs[0],
        { label: 'Inventory', to: machineLogbookPaths.inventory(listTab) },
        { label: material.name },
      ]}
      actions={actions}
    >
      <div className="mj-stack">
        {material.attention.length > 0 && (
          <ActionableNotification
            inline
            kind="warning"
            lowContrast
            hideCloseButton
            role="status"
            title="Needs attention"
            subtitle={material.attention.map((item) => item.message).join(' · ')}
            actionButtonLabel={allowed.receive ? 'Receive stock' : ''}
            onActionButtonClick={() => setDialog({ name: 'receive' })}
          />
        )}
        <FactTiles
          label="Article figures"
          items={[
            {
              label: 'Stock',
              value: formatQuantity(material.quantity, material.unit, material.countLabel),
              helper: stockHelper(material, spools.data?.length),
            },
            {
              label: 'Minimum',
              value:
                material.lowStockThreshold != null
                  ? formatQuantity(material.lowStockThreshold, material.unit, material.countLabel)
                  : '—',
              helper: minimumHelper(material),
            },
            {
              label: 'Used 30 d',
              value: formatQuantity(material.recentConsumption, material.unit, material.countLabel),
              helper: material.machineUse ? 'runs and orders' : 'orders and consumption',
            },
            {
              label: 'Stock value',
              value: formatMoney(material.inventoryValue),
              helper:
                unitCost != null
                  ? `at ${formatUnitCost(unitCost, material.unit, material.countLabel)} average cost`
                  : 'no purchase yet',
            },
            {
              label: material.kind === 'part' ? 'Category' : 'Material type',
              value: material.materialTypeName,
              helper: material.variant ? `Variant ${material.variant}` : 'No variant',
            },
            {
              label: 'Location',
              value: material.storageLocation || '—',
              helper: material.manufacturer || 'No manufacturer',
            },
          ]}
        />
        <div className="inv-article-layout">
          <div className="mj-stack">
            {filament && (
              <SpoolsSection
                material={material}
                onRegister={allowed.register && loose > 0 ? () => setDialog({ name: 'register' }) : undefined}
              />
            )}
            <section className="mj-stack" aria-labelledby="article-ledger-title">
              <h2 id="article-ledger-title" className="inv-section-title">
                Ledger <span className="inv-count">{ledger.data?.length ?? ''}</span>
              </h2>
              <QueryBoundary query={ledger} errorMessage="The ledger could not be loaded.">
                {(items) => (
                  <InventoryLedgerTable
                    id="ledger"
                    transactions={items}
                    unit={material.unit}
                    countLabel={material.countLabel}
                    showSpool={filament}
                    onDelete={
                      allowed.deleteLedger
                        ? (transaction) => setDialog({ name: 'ledger-delete', transaction })
                        : undefined
                    }
                  />
                )}
              </QueryBoundary>
            </section>
          </div>
          <div className="mj-stack">
            <StackCard
              title="Prices"
              action={
                can('pricing.read') ? (
                  <Button kind="ghost" size="sm" as={Link} to="/pricing">
                    Pricing
                  </Button>
                ) : undefined
              }
            >
              {material.prices.length === 0 ? (
                <p className="mj-secondary">No sale price in any pricing group, so it cannot be sold on an order.</p>
              ) : (
                <FactsGrid columns={2}>
                  {material.prices.map((price) => (
                    <Fact
                      key={price.pricingGroupId}
                      label={price.pricingGroupName}
                      helper={priceSourceLabel[price.source]}
                    >
                      {formatRate(price.rate, material.unit, material.countLabel)}
                    </Fact>
                  ))}
                </FactsGrid>
              )}
              <p className="mj-secondary">
                {material.machineUse
                  ? `Runs use the ${material.materialTypeName} rate; prices for selling from stock are set per pricing group under Sales → Pricing.`
                  : 'Set per pricing group under Sales → Pricing; used when the article is sold on an order.'}
              </p>
            </StackCard>
            <StackCard title="Facts">
              <FactsGrid columns={2}>
                <Fact label="Article number">{material.displayId}</Fact>
                <Fact label="Kind">{kindNames[material.kind]}</Fact>
                <Fact
                  label={material.kind === 'part' ? 'Category' : 'Material type'}
                  helper={material.materialTypeCode}
                >
                  {material.materialTypeName}
                </Fact>
                <Fact label="Variant">{material.variant || '—'}</Fact>
                {(material.colorName || material.colorHex) && (
                  <Fact label="Colour" helper={material.colorHex ?? undefined}>
                    <span className="inv-name">
                      <ColorSwatch hex={material.colorHex} name={material.colorName} />
                      {material.colorName || material.colorHex}
                    </span>
                  </Fact>
                )}
                <Fact label="Manufacturer">{material.manufacturer || '—'}</Fact>
                <Fact label="Package">
                  {material.packageSize != null
                    ? formatQuantity(material.packageSize, material.unit, material.countLabel)
                    : '—'}
                </Fact>
                <Fact label="Unit cost">{formatUnitCost(unitCost, material.unit, material.countLabel)}</Fact>
                <Fact label="Unit">{articleUnitLabel(material.unit, material.countLabel)}</Fact>
                {material.filamentDiameterMm != null && (
                  <Fact label="Diameter">{Number(material.filamentDiameterMm)} mm</Fact>
                )}
                <Fact label="Machine use">{material.machineUse ? 'Yes' : 'No'}</Fact>
                <Fact label="Status">{material.active ? 'Active' : 'Inactive'}</Fact>
              </FactsGrid>
            </StackCard>
            <StackCard
              title="Notes"
              action={
                allowed.manage ? (
                  <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => setDialog({ name: 'edit' })}>
                    {material.notes ? 'Edit' : 'Add'}
                  </Button>
                ) : undefined
              }
            >
              <p className={material.notes ? 'inv-notes' : 'mj-secondary'}>{material.notes || 'No notes.'}</p>
            </StackCard>
          </div>
        </div>
      </div>
      <ArticleDialogs
        material={material}
        dialog={dialog}
        onClose={() => setDialog(null)}
        onDeleted={() => navigate(machineLogbookPaths.inventory(listTab))}
      />
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
          description="It may be in the inventory recycle bin or deleted for good, or the link is incorrect."
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
