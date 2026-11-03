import { Button, Link as CarbonLink, OverflowMenu, OverflowMenuItem, Tag } from '@carbon/react';
import { ArrowRight, Close } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { FilamentSpool, InventoryTransaction, Material } from '../../../api/generated/models';
import { DetailPanel, DetailPanelHead, DetailPanelSection } from '../../../app/components/DetailPanel';
import { Fact, FactsGrid } from '../../../app/components/Facts';
import { formatDate } from '../../../app/dateTime';
import { machineLogbookPaths } from '../shared/paths';
import { allSpoolTransactionsQuery } from '../spoolData';
import { ArticleMeta } from './ArticlePanel';
import { formatGrams } from './inventoryShared';
import { ledgerQuantityText, ledgerReferenceText, transactionKindLabel } from './InventoryLedgerTable';
import { PanelTable } from './PanelTable';
import { spoolActionsFor, useSpoolPermissions, type SpoolDialog } from './spoolActions';
import {
  articleShortName,
  initialOf,
  isRetired,
  nfcTagOf,
  remainingOf,
  retireOutcomeText,
  spoolPercent,
  SpoolStateTag,
  whereText,
} from './spoolShared';

const PANEL_LEDGER_ROWS = 8;

/** Spool tags: mounted, in storage or retired, and whether printers can recognise it. */
export function SpoolTags({ spool, size = 'sm' }: { spool: FilamentSpool; size?: 'sm' | 'md' }) {
  return (
    <span className="inv-tags">
      <SpoolStateTag spool={spool} size={size} />
      {nfcTagOf(spool) ? (
        <Tag type="blue" size={size}>
          RFID
        </Tag>
      ) : (
        <Tag type="outline" size={size}>
          No tag
        </Tag>
      )}
    </span>
  );
}

/** The permanent panel of the spools table and the bin: where the spool is, what is left and what it was used for. */
export function SpoolPanel({
  spool,
  material,
  onClose,
  onAction,
}: {
  spool: FilamentSpool;
  /** The spool's article when it is loaded, for its short name and storage location. */
  material?: Material;
  onClose: () => void;
  onAction: (dialog: SpoolDialog) => void;
}) {
  const allowed = useSpoolPermissions();
  const ledger = useQuery(allSpoolTransactionsQuery(spool.id));
  const entries = [...(ledger.data ?? [])].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
  const retired = isRetired(spool);
  const actions = spoolActionsFor(spool, allowed);
  const primary = actions.find((item) => item.id === (retired ? 'restore' : 'weigh'));
  const menu = actions.filter((item) => item !== primary);
  const used = Math.max(0, initialOf(spool) - remainingOf(spool));
  const consumption = entries.filter((tx) => Number(tx.quantityDelta) < 0).length;
  const tag = nfcTagOf(spool);

  return (
    <DetailPanel>
      <DetailPanelHead
        title={<span title={spool.materialName}>{material ? articleShortName(material) : spool.materialName}</span>}
        meta={<ArticleMeta material={spool} />}
        secondary={`${spool.displayId} · ${whereText(spool)}`}
        helper={<SpoolTags spool={spool} />}
        actions={
          <Button
            hasIconOnly
            kind="ghost"
            size="sm"
            renderIcon={Close}
            iconDescription="Close panel"
            tooltipPosition="left"
            onClick={onClose}
          />
        }
      />
      <div className="inv-panel-actions">
        <Button size="sm" renderIcon={ArrowRight} as={Link} to={machineLogbookPaths.spool(spool.id)}>
          Open spool
        </Button>
        {primary && (
          <Button size="sm" kind="tertiary" onClick={() => onAction(primary.id)}>
            {primary.label}
          </Button>
        )}
        {menu.length > 0 && (
          <OverflowMenu size="sm" aria-label="More spool actions" iconDescription="More spool actions" flipped>
            {menu.map((item) => (
              <OverflowMenuItem
                key={item.id}
                itemText={item.label}
                isDelete={item.danger}
                hasDivider={item.danger}
                onClick={() => onAction(item.id)}
              />
            ))}
          </OverflowMenu>
        )}
      </div>
      <FactsGrid columns={2}>
        <Fact
          label="Remaining"
          helper={
            retired
              ? [retireOutcomeText(spool), spool.archivedAt ? formatDate(spool.archivedAt) : null]
                  .filter(Boolean)
                  .join(' · ')
              : `${spoolPercent(spool)} % of ${formatGrams(initialOf(spool))}`
          }
        >
          {retired ? 'Retired' : formatGrams(remainingOf(spool))}
        </Fact>
        <Fact label="Used" helper={`${consumption} ${consumption === 1 ? 'booking' : 'bookings'}`}>
          {formatGrams(used)}
        </Fact>
        <Fact
          label="Where"
          helper={
            retired
              ? 'no longer in stock'
              : spool.mounted
                ? tag
                  ? 'mounted, RFID tag'
                  : 'mounted by hand'
                : 'in storage'
          }
        >
          {whereText(spool)}
        </Fact>
        <Fact label="Tag" helper={tag ? 'RFID, printers recognise it' : 'printers cannot detect it'}>
          {tag ? <span className="inv-mono">{tag}</span> : '—'}
        </Fact>
        <Fact label="Article" helper={material?.storageLocation ?? undefined}>
          <CarbonLink as={Link} to={machineLogbookPaths.material(spool.materialId)} size="sm">
            {spool.materialDisplayId}
          </CarbonLink>
        </Fact>
        <Fact label="Registered" helper={spool.acquisitionReference ?? undefined}>
          {formatDate(spool.acquiredOn ?? spool.createdAt)}
        </Fact>
      </FactsGrid>
      {spool.notes && <p className="inv-panel-notes">{spool.notes}</p>}
      <DetailPanelSection title={`Bookings · ${ledger.data?.length ?? '…'}`}>
        <PanelTable<InventoryTransaction>
          label={`Bookings on ${spool.displayId}`}
          rows={entries.slice(0, PANEL_LEDGER_ROWS)}
          emptyText={ledger.isError ? 'The bookings could not be loaded.' : 'Nothing booked on this spool yet.'}
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
            { key: 'quantity', header: 'Quantity', numeric: true, render: (tx) => ledgerQuantityText(tx, 'g') },
          ]}
        />
      </DetailPanelSection>
    </DetailPanel>
  );
}
