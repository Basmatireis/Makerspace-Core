import { useState, type ReactNode } from 'react';
import type { FilterCategory } from '../../app/BatchFilter';
import { Button, TableCell } from '@carbon/react';
import { Download } from '@carbon/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { CashJournal, CashJournalEntry } from '../../api/generated/models';
import { ListWithPanel, useListPanelLayout } from '../../app/components/ListWithPanel';
import { RefLink } from '../../app/RefLink';
import { formatTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { DirectoryTable, useServerTableState, type Column } from '../machinelogbook/shared/DirectoryTable';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { CashCountModal } from './CashCountModal';
import { CashMovementModal } from './CashMovementModal';
import { DeleteCashEntryDialog } from './DeleteCashEntryDialog';
import {
  daysByDate,
  isJournalKind,
  journalDayText,
  journalEntryText,
  journalKindLabel,
  journalKindOptions,
} from './cashJournal';
import { ExportCashbookModal } from './ExportCashbookModal';
import { formatCents, toCents } from './money';
import { FilterTags, usePeriodFilter } from './PeriodFilter';
import { DifferenceTag, EntryPanel, RegisterPanel, type RegisterAction } from './RegisterPanel';
import { cashJournalQuery } from './queries';

const PAGE_SIZES = [25, 50, 100];
// Newest first; the journal has no other order.
const DEFAULT_SORT = { key: 'time', direction: 'DESC' as const };

/**
 * The cash register: every cash entry with the running balance, grouped by day, next to what should be in the register
 * and the actions on it. From 1056 px on a row shows the entry in the panel instead.
 */
export function CashRegisterTab() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const periodFilter = usePeriodFilter();
  const { period } = periodFilter;
  const table = useServerTableState('', DEFAULT_SORT, PAGE_SIZES, PAGE_SIZES[0]);
  const kinds = table.url.list('kind').filter(isJournalKind);
  const panelFits = useListPanelLayout();
  const [dialog, setDialog] = useState<RegisterAction | 'export' | null>(null);
  const [editing, setEditing] = useState<CashJournalEntry | null>(null);
  const [deleting, setDeleting] = useState<CashJournalEntry | null>(null);
  const canRecord = hasPermission(user, PermissionId.cash_movementsrecord);
  const canManage = hasPermission(user, PermissionId.cash_movementsmanage);
  const journal = useQuery({
    ...cashJournalQuery({
      ...(period.from ? { from: period.from } : {}),
      ...(period.to ? { to: period.to } : {}),
      ...(kinds.length ? { kind: kinds } : {}),
      ...(table.search ? { search: table.search } : {}),
      direction: 'desc',
      page: table.page,
      pageSize: table.pageSize,
    }),
    placeholderData: keepPreviousData,
  });

  // Selecting keeps the page, search and filters; only the panel changes.
  const select = (id: string | null) =>
    setParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        if (id) next.set('entry', id);
        else next.delete('entry');
        return next;
      },
      { replace: true },
    );

  const registerPanel = (data: CashJournal) => (
    <RegisterPanel journal={data} period={period} onAction={setDialog} canCount={canRecord} canMove={canRecord} />
  );

  return (
    <div className="mj-stack">
      {periodFilter.note}
      <QueryBoundary query={journal} errorMessage="The cash register could not be loaded.">
        {(data: CashJournal) => {
          const selected = panelFits ? (data.items.find((entry) => entry.id === params.get('entry')) ?? null) : null;
          return (
            <>
              {!panelFits && registerPanel(data)}
              <ListWithPanel
                panelLabel="Cash register"
                panel={
                  selected ? (
                    <EntryPanel
                      entry={selected}
                      canOrders={hasPermission(user, PermissionId.ordersread)}
                      canManage={canManage}
                      onEdit={setEditing}
                      onDelete={setDeleting}
                      onClose={() => select(null)}
                    />
                  ) : (
                    registerPanel(data)
                  )
                }
              >
                <JournalTable
                  journal={data}
                  selectedId={selected?.id ?? null}
                  panelFits={panelFits}
                  onSelect={(entry) => {
                    if (panelFits) select(entry.id === selected?.id ? null : entry.id);
                    else if (entry.source === 'payment') void navigate(`/payments/${entry.id}`);
                  }}
                  filterTags={periodFilter.tag}
                  categories={[periodFilter.category, { key: 'kind', label: 'Kind', options: journalKindOptions }]}
                  onExport={() => setDialog('export')}
                />
              </ListWithPanel>
            </>
          );
        }}
      </QueryBoundary>
      {periodFilter.dialog}
      {dialog === 'count' && <CashCountModal onClose={() => setDialog(null)} />}
      {(dialog === 'withdrawal' || dialog === 'deposit') && (
        <CashMovementModal kind={dialog} onClose={() => setDialog(null)} />
      )}
      {editing?.kind === 'count' && <CashCountModal entry={editing} onClose={() => setEditing(null)} />}
      {(editing?.kind === 'withdrawal' || editing?.kind === 'deposit') && (
        <CashMovementModal kind={editing.kind} entry={editing} onClose={() => setEditing(null)} />
      )}
      {deleting && (
        <DeleteCashEntryDialog
          entry={deleting}
          onDeleted={() => {
            setDeleting(null);
            select(null);
          }}
          onClose={() => setDeleting(null)}
        />
      )}
      {dialog === 'export' && (
        <ExportCashbookModal period={period} contents="cash_register" onClose={() => setDialog(null)} />
      )}
    </div>
  );
}

function JournalTable({
  journal,
  selectedId,
  panelFits,
  onSelect,
  filterTags,
  categories,
  onExport,
}: {
  journal: CashJournal;
  selectedId: string | null;
  panelFits: boolean;
  onSelect: (entry: CashJournalEntry) => void;
  filterTags: ReactNode;
  categories: FilterCategory[];
  onExport: () => void;
}) {
  const days = daysByDate(journal.days);
  const columns: Column<CashJournalEntry>[] = [
    { key: 'time', header: 'Time', render: (entry) => formatTime(entry.occurredAt) },
    { key: 'type', header: 'Type', render: (entry) => journalKindLabel[entry.kind] },
    {
      key: 'reference',
      header: 'Reference',
      render: (entry) => (
        <div className="mj-cell-stack sales-journal-ref">
          {panelFits ? (
            <button
              type="button"
              className={`sales-ref-button${entry.id === selectedId ? ' sales-row-selected' : ''}`}
              aria-pressed={entry.id === selectedId}
              onClick={() => onSelect(entry)}
            >
              {entry.reference}
            </button>
          ) : entry.source === 'payment' ? (
            <RefLink reference={entry.reference} id={entry.id} kind="payment" />
          ) : (
            <span className="sales-journal-ref__plain">{entry.reference}</span>
          )}
          <span className="mj-secondary">{journalEntryText(entry)}</span>
        </div>
      ),
    },
    {
      key: 'in',
      header: 'In',
      className: 'sales-num',
      render: (entry) => (entry.amountIn ? formatCents(toCents(entry.amountIn)) : ''),
    },
    {
      key: 'out',
      header: 'Out',
      className: 'sales-num',
      render: (entry) => (entry.amountOut ? formatCents(toCents(entry.amountOut)) : ''),
    },
    {
      key: 'balance',
      header: 'Balance',
      className: 'sales-num',
      render: (entry) =>
        entry.count ? (
          toCents(entry.count.difference) === 0 ? (
            <span className="mj-secondary">—</span>
          ) : (
            <DifferenceTag difference={toCents(entry.count.difference)} />
          )
        ) : (
          formatCents(toCents(entry.balanceAfter))
        ),
    },
    { key: 'by', header: 'By', narrow: true, render: (entry) => entry.recordedBy?.displayName ?? '—' },
  ];
  const label = 'Cash journal';
  return (
    <DirectoryTable<CashJournalEntry>
      mode="server"
      id="cash-journal"
      urlPrefix=""
      label={label}
      columns={columns}
      rows={journal.items}
      total={journal.total}
      pageSizes={PAGE_SIZES}
      defaultPageSize={PAGE_SIZES[0]}
      onRowClick={onSelect}
      switcher={<FilterTags period={filterTags} categories={categories} />}
      filterCategories={categories}
      groups={{
        of: (entry) => entry.day,
        head: (date) => {
          const day = days.get(date);
          return (
            <>
              <TableCell colSpan={5}>
                <strong>{journalDayText(date)}</strong>
                {day && (
                  <span className="mj-secondary"> · opening balance {formatCents(toCents(day.openingBalance))}</span>
                )}
              </TableCell>
              <TableCell className="sales-num">
                <strong>{day ? formatCents(toCents(day.closingBalance)) : ''}</strong>
              </TableCell>
              <TableCell className="mj-hide-narrow" />
            </>
          );
        },
      }}
      toolbarAction={
        <Button kind="ghost" size="md" renderIcon={Download} onClick={onExport}>
          Export
        </Button>
      }
      empty={{
        title: 'No cash entries in this period',
        description: 'Receipts, refunds, withdrawals, deposits and counts in cash appear here.',
      }}
    />
  );
}
