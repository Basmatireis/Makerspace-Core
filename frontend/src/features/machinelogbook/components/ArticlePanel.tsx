/* eslint-disable react-refresh/only-export-components -- the panel and the head pieces the pages reuse belong together */
import type { ReactNode } from 'react';
import { Button, Link as CarbonLink, OverflowMenu, OverflowMenuItem, Tag } from '@carbon/react';
import { Add, ArrowRight, Close } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { InventoryTransaction, Material } from '../../../api/generated/models';
import { DetailPanel, DetailPanelHead, DetailPanelSection } from '../../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../../app/components/Facts';
import { formatDate } from '../../../app/dateTime';
import { allTransactionsQuery } from '../inventoryQueries';
import { formatMoney } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { allSpoolsQuery } from '../spoolData';
import { useArticlePermissions, type ArticleDialog } from './articleActions';
import {
  ColorSwatch,
  formatQuantity,
  formatRate,
  formatUnitCost,
  isFilament,
  materialUnitCost,
  priceSourceLabel,
  StockTag,
} from './inventoryShared';
import { ledgerQuantityText, ledgerReferenceText, transactionKindLabel } from './InventoryLedgerTable';
import { PanelTable } from './PanelTable';
import { articleShortName, SpoolRemaining, whereText } from './spoolShared';

/** How many ledger entries the panel lists; the article page has the whole ledger. */
const PANEL_LEDGER_ROWS = 8;

/** Line 2 of a head: colour and manufacturer, separated by a middle dot. */
export function ArticleMeta({ material }: { material: Pick<Material, 'colorHex' | 'colorName' | 'manufacturer'> }) {
  const parts: ReactNode[] = [];
  if (material.colorHex || material.colorName)
    parts.push(
      <span key="colour" className="inv-meta-item">
        <ColorSwatch hex={material.colorHex} name={material.colorName} />
        {material.colorName || material.colorHex}
      </span>,
    );
  if (material.manufacturer) parts.push(<span key="maker">{material.manufacturer}</span>);
  if (parts.length === 0) return <span className="mj-secondary">No manufacturer</span>;
  return (
    <span className="inv-meta">
      {parts.flatMap((part, index) => (index === 0 ? [part] : [<span key={`dot-${index}`}>·</span>, part]))}
    </span>
  );
}

/** Tags of an article: stock state, spools and machine use. */
export function ArticleTags({ material, size = 'sm' }: { material: Material; size?: 'sm' | 'md' }) {
  return (
    <span className="inv-tags">
      {material.active ? (
        <StockTag state={material.stockState} size={size} />
      ) : (
        <Tag type="gray" size={size}>
          Inactive
        </Tag>
      )}
      {isFilament(material) && (
        <Tag type="blue" size={size}>
          Kept on spools
        </Tag>
      )}
      {material.machineUse && (
        <Tag type="outline" size={size}>
          Machine use
        </Tag>
      )}
    </span>
  );
}

/** Stock helper text: spools and loose stock for filament, packages for everything else. */
export function stockHelper(material: Material, spoolCount: number | undefined) {
  if (isFilament(material))
    return `${spoolCount === undefined ? 'On spools' : `${spoolCount} ${spoolCount === 1 ? 'spool' : 'spools'}`} · ${formatQuantity(material.unassignedQuantity, material.unit)} loose`;
  const size = Number(material.packageSize ?? 0);
  if (size > 0)
    return `≈ ${Math.round((Number(material.quantity) / size) * 10) / 10} × ${formatQuantity(size, material.unit)}`;
  return undefined;
}

export function minimumHelper(material: Material) {
  if (material.lowStockThreshold == null) return 'not set';
  const left = Number(material.quantity) - Number(material.lowStockThreshold);
  return left <= 0 ? 'at or below minimum' : `${formatQuantity(left, material.unit)} above`;
}

/** The permanent panel of the articles table: fixed head, facts, active spools and the latest ledger entries. */
export function ArticlePanel({
  material,
  onClose,
  onAction,
}: {
  material: Material;
  onClose: () => void;
  onAction: (dialog: ArticleDialog) => void;
}) {
  const allowed = useArticlePermissions();
  const filament = isFilament(material);
  const spools = useQuery({
    ...allSpoolsQuery({ materialId: material.id, lifecycle: 'active' }),
    enabled: filament,
  });
  const ledger = useQuery(allTransactionsQuery(material.id));
  const entries = [...(ledger.data ?? [])].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const unitCost = materialUnitCost(material);
  const titleId = `article-panel-${material.id}`;

  return (
    <DetailPanel>
      <DetailPanelHead
        titleId={titleId}
        title={<span title={material.name}>{articleShortName(material)}</span>}
        meta={<ArticleMeta material={material} />}
        secondary={[material.displayId, material.storageLocation].filter(Boolean).join(' · ')}
        helper={<ArticleTags material={material} />}
        actions={
          <Button
            hasIconOnly
            kind="ghost"
            size="sm"
            renderIcon={Close}
            iconDescription="Close panel"
            onClick={onClose}
          />
        }
      />
      <div className="inv-panel-actions">
        <Button size="sm" renderIcon={ArrowRight} as={Link} to={machineLogbookPaths.material(material.id)}>
          Open article
        </Button>
        {allowed.manage && (
          <Button size="sm" kind="tertiary" renderIcon={Add} onClick={() => onAction({ name: 'receive' })}>
            Receive stock
          </Button>
        )}
        {(allowed.manage || allowed.delete) && (
          <OverflowMenu size="sm" aria-label="More article actions" iconDescription="More article actions" flipped>
            {allowed.manage && <OverflowMenuItem itemText="Edit article" onClick={() => onAction({ name: 'edit' })} />}
            {filament && allowed.register && (
              <OverflowMenuItem itemText="Register spool" onClick={() => onAction({ name: 'register' })} />
            )}
            {allowed.delete && (
              <OverflowMenuItem
                itemText="Delete article"
                isDelete
                hasDivider
                onClick={() => onAction({ name: 'delete' })}
              />
            )}
          </OverflowMenu>
        )}
      </div>
      <FactsGrid columns={2}>
        <Fact label="Stock" helper={stockHelper(material, spools.data?.length)}>
          {formatQuantity(material.quantity, material.unit)}
        </Fact>
        <Fact label="Minimum" helper={minimumHelper(material)}>
          {material.lowStockThreshold != null ? formatQuantity(material.lowStockThreshold, material.unit) : '—'}
        </Fact>
        <Fact label="Used 30 d" helper={material.machineUse ? 'runs and orders' : 'orders and consumption'}>
          {formatQuantity(material.recentConsumption, material.unit)}
        </Fact>
        <Fact
          label="Stock value"
          helper={unitCost != null ? `at ${formatUnitCost(unitCost, material.unit)}` : undefined}
        >
          {formatMoney(material.inventoryValue)}
        </Fact>
        {material.prices.map((price) => (
          <Fact key={price.pricingGroupId} label={price.pricingGroupName} helper={priceSourceLabel[price.source]}>
            {formatRate(price.rate, material.unit)}
          </Fact>
        ))}
        {material.prices.length === 0 && (
          <Fact
            label="Sale price"
            helper={
              <CarbonLink as={Link} to="/pricing" size="sm">
                Set in Pricing
              </CarbonLink>
            }
          >
            None
          </Fact>
        )}
        <Fact label="Package" helper={material.variant ? `Variant ${material.variant}` : undefined}>
          {material.packageSize != null ? formatQuantity(material.packageSize, material.unit) : '—'}
        </Fact>
        <Fact label="Category" helper={material.materialTypeCode}>
          {material.materialTypeName}
        </Fact>
      </FactsGrid>
      {material.notes && <p className="inv-panel-notes">{material.notes}</p>}
      {filament && (
        <DetailPanelSection title={`Spools · ${spools.data?.length ?? '…'}`}>
          <PanelTable
            label={`Spools of ${material.name}`}
            rows={spools.data ?? []}
            emptyText={
              Number(material.unassignedQuantity) > 0
                ? 'No active spools. Register one from loose stock.'
                : 'No active spools.'
            }
            columns={[
              {
                key: 'label',
                header: 'Spool',
                render: (spool) => (
                  <CarbonLink as={Link} to={machineLogbookPaths.spool(spool.id)} className="inv-mono" size="sm">
                    {spool.displayId}
                  </CarbonLink>
                ),
              },
              { key: 'where', header: 'Where', render: (spool) => whereText(spool) },
              {
                key: 'remaining',
                header: 'Remaining',
                numeric: true,
                render: (spool) => <SpoolRemaining spool={spool} />,
              },
            ]}
          />
        </DetailPanelSection>
      )}
      <DetailPanelSection
        title={`Ledger · ${ledger.data?.length ?? '…'}`}
        action={
          entries.length > PANEL_LEDGER_ROWS ? (
            <CarbonLink as={Link} to={machineLogbookPaths.material(material.id)} size="sm">
              All entries
            </CarbonLink>
          ) : undefined
        }
      >
        <PanelTable<InventoryTransaction>
          label={`Ledger of ${material.name}`}
          rows={entries.slice(0, PANEL_LEDGER_ROWS)}
          emptyText={ledger.isError ? 'The ledger could not be loaded.' : 'No entries.'}
          columns={[
            { key: 'date', header: 'Date', render: (tx) => formatDate(tx.occurredAt) },
            {
              key: 'entry',
              header: 'Entry',
              render: (tx) => (
                <div className="mj-cell-stack">
                  <span>{transactionKindLabel(tx)}</span>
                  {ledgerReferenceText(tx) && <span className="mj-secondary">{ledgerReferenceText(tx)}</span>}
                </div>
              ),
            },
            {
              key: 'quantity',
              header: 'Quantity',
              numeric: true,
              render: (tx) => ledgerQuantityText(tx, material.unit),
            },
          ]}
        />
      </DetailPanelSection>
    </DetailPanel>
  );
}

/** The panel while nothing is selected. */
export function EmptyPanel({ text }: { text: string }) {
  return (
    <DetailPanel className="inv-panel-empty">
      <p>{text}</p>
    </DetailPanel>
  );
}
