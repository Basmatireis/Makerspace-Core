import { useMemo, useState } from 'react';
import {
  Button, Link as CarbonLink, Pagination, RadioButton, RadioButtonGroup, Table, TableBody, TableCell, TableContainer,
  TableHead, TableHeader, TableRow, TableToolbar, TableToolbarContent, TableToolbarSearch, Tile, Toggletip, ToggletipButton, ToggletipContent,
} from '@carbon/react';
import { Add, Download, Information, Subtract } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import { DateInput } from '../../../../app/DateInput';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { timeInAppTimeZone } from '../../../../app/dateTime';
import { BatchFilter, toPatch, type FilterValues } from '../../components/BatchFilter';
import { QueryBoundary } from '../../components/QueryBoundary';
import { RefLink } from '../../components/RefLink';
import { useStore } from '../../store';
import { RequirePermission } from '../components/RequirePermission';
import { CashMovementModal } from '../dialogs/CashMovementModal';
import { downloadCsv, toCsv } from '../csv';
import { dateInAppTimeZone, formatDate, formatDateTime, formatEur, formatSignedEur, round2 } from '../format';
import { cashMovementKindLabel, cashMovementReasonLabel, customerKindLabel, methodLabel, methodFilterOptions, movementKind, paymentKind, reasonKindLabel } from '../labels';
import { cashbookLines, cashInRegister, periodPresets, periodRange, takings, type CashbookLine, type PeriodPreset } from '../logic';
import { MovementKindTag, PaymentKindTag } from '../status';
import { useSalesData } from '../useSalesData';
import { useUrlParams } from '../useUrlParams';
import type { CashMovement, CashMovementKind, Payment, PaymentMethod } from '../types';
import '../sales.scss';

const PAGE_SIZES = [10, 25, 50];
/** The period is a filter category too; Today is the default and is not a stored value. */
const FILTER_KEYS = ['period', 'from', 'to', 'method', 'kind', 'who'] as const;
const ROW_FILTER_KEYS = ['method', 'kind', 'who'] as const;
const KIND_OPTIONS = [{ id: 'receipt', label: 'Receipt' }, { id: 'refund', label: 'Refund' }, { id: 'correction', label: 'Correction' }, { id: 'withdrawal', label: cashMovementKindLabel('withdrawal') }, { id: 'deposit', label: cashMovementKindLabel('deposit') }];
const WHO_OPTIONS = [{ id: 'person', label: customerKindLabel('person') }, { id: 'organization', label: customerKindLabel('organization') }];
const kindId = (line: CashbookLine) => line.type === 'movement' ? line.movement.kind : paymentKind(line.payment).label.toLowerCase();
const lineKindLabel = (line: CashbookLine) => line.type === 'movement' ? movementKind(line.movement).label : paymentKind(line.payment).label;

function amountText(line: CashbookLine) {
  return line.type === 'movement' || line.payment.entryKind === 'reversal' ? formatSignedEur(line.signed) : formatEur(line.signed);
}

/** The cashbook as a spreadsheet file, cash movements included. Semicolons and decimal commas (12,50) so German and Austrian spreadsheets open it in columns. */
function exportLines(lines: CashbookLine[], filename: string) {
  const rows = lines.map((line) => line.type === 'movement'
    ? [line.reference, dateInAppTimeZone(line.at), timeInAppTimeZone(line.at), lineKindLabel(line), methodLabel('cash'), line.signed.toFixed(2).replace('.', ','), '', '', '', '', cashMovementReasonLabel[line.movement.reason], line.movement.note, line.recordedBy, dateInAppTimeZone(line.movement.recordedAt)]
    : [
      line.reference, dateInAppTimeZone(line.at), timeInAppTimeZone(line.at), lineKindLabel(line), methodLabel(line.payment.method), line.signed.toFixed(2).replace('.', ','),
      line.order?.reference ?? '', line.order?.customerName ?? '', line.payment.terminal, line.payment.transactionReference,
      line.payment.reasonKind ? reasonKindLabel(line.payment.reasonKind) : '', line.payment.reason, line.recordedBy, dateInAppTimeZone(line.payment.recordedAt),
    ]);
  downloadCsv(filename, toCsv(['Entry', 'Date', 'Time', 'Kind', 'Method', 'Amount EUR', 'Order', 'Customer', 'Terminal', 'Transaction reference', 'Reason kind', 'Reason or note', 'Recorded by', 'Recorded on'], rows));
}

function Cashbook({ lines, empty, canRecord, payments, movements }: { lines: CashbookLine[]; empty: boolean; canRecord: boolean; payments: Payment[]; movements: CashMovement[] }) {
  const store = useStore();
  const [movement, setMovement] = useState<CashMovementKind | null>(null);
  const navigate = useNavigate();
  const { params, update, list } = useUrlParams();
  const [searchKey, setSearchKey] = useState(0);
  const preset = (periodPresets.find((item) => item.id === params.get('period'))?.id ?? 'today') as PeriodPreset;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const search = params.get('q') ?? '';
  const methods = list('method'); const kinds = list('kind'); const who = list('who');
  const activeFilters = ROW_FILTER_KEYS.filter((key) => params.get(key)).length;
  const appliedFilters: FilterValues = { period: preset === 'today' ? [] : [preset], from: from ? [from] : [], to: to ? [to] : [], method: methods, kind: kinds, who };
  const range = periodRange(preset, from, to);

  const inPeriod = useMemo(() => range.valid ? lines.filter((line) => { const at = new Date(line.at).getTime(); return at >= range.from && at < range.to; }) : [], [lines, range.from, range.to, range.valid]);
  const register = useMemo(() => cashInRegister(payments, movements, range.to), [payments, movements, range.to]);
  const tiles = useMemo(() => {
    const paymentLines = inPeriod.flatMap((line) => line.type === 'payment' ? [line] : []);
    const net = takings(paymentLines.map((line) => line.payment), range.from, range.to);
    const count = (method: PaymentMethod | null) => {
      const mine = paymentLines.filter((line) => method === null || line.payment.method === method);
      const receipts = mine.filter((line) => line.payment.entryKind === 'receipt').length; const undone = mine.length - receipts;
      return `${receipts} ${receipts === 1 ? 'receipt' : 'receipts'} · ${undone} ${undone === 1 ? 'refund or correction' : 'refunds or corrections'}`;
    };
    return [
      { key: 'total', label: 'Net takings', value: net.total, detail: count(null) },
      { key: 'cash', label: 'Cash', value: net.cash, detail: count('cash') },
      { key: 'card', label: 'Card', value: net.card, detail: count('card') },
      { key: 'external', label: 'Invoice (wiRef)', value: net.external, detail: count('external') },
    ];
  }, [inPeriod, range.from, range.to]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return inPeriod.filter((line) => (methods.length === 0 || methods.includes(line.method)) && (kinds.length === 0 || kinds.includes(kindId(line))) && (who.length === 0 || (line.customerKind !== null && who.includes(line.customerKind)))
      && (!needle || `${line.reference} ${line.order?.reference ?? ''} ${line.customerLabel} ${line.type === 'payment' ? line.payment.transactionReference : `${cashMovementReasonLabel[line.movement.reason]} ${line.movement.note}`} ${line.recordedBy}`.toLowerCase().includes(needle)));
  }, [inPeriod, search, methods.join(','), kinds.join(','), who.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageSize = PAGE_SIZES.includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 10;
  const page = Math.max(1, Math.min(Number(params.get('page')) || 1, Math.ceil(visible.length / pageSize) || 1));
  const rows = visible.slice((page - 1) * pageSize, page * pageSize);
  const clearAll = () => { update({ ...Object.fromEntries(FILTER_KEYS.map((key) => [key, null])), q: null }); setSearchKey((value) => value + 1); };
  const periodText = !range.valid ? 'Custom range · choose both dates' : preset === 'custom' ? `Custom range · ${formatDate(`${from}T12:00:00Z`)} to ${formatDate(`${to}T12:00:00Z`)}`
    : `${range.label} · ${formatDate(new Date(range.from).toISOString())}${preset === 'today' || preset === 'yesterday' ? '' : ` to ${formatDate(new Date(range.to - 1).toISOString())}`}`;
  const filename = `cashbook-${preset === 'custom' ? `${from}_${to}` : dateInAppTimeZone(new Date(range.from))}.csv`;

  return (
    <div className="mj-stack">
      <p className="sales-period-note" aria-live="polite"><strong>{periodText}</strong></p>

      <section className="sales-tiles" aria-label="Takings by method">
        {tiles.map((tile) => (
          <Tile key={tile.key} className="sales-tile">
            <span className="sales-tile__label">{tile.label}</span>
            <span className="sales-tile__value">{range.valid ? formatEur(round2(tile.value)) : '—'}</span>
            <span className="mj-secondary">{range.valid ? tile.detail : 'Choose both dates'}</span>
          </Tile>
        ))}
        <Tile className="sales-tile">
          <span className="sales-tile__label mj-inline">Cash in register (expected)
            <Toggletip align="bottom-start">
              <ToggletipButton label="Show how the expected cash is calculated"><Information /></ToggletipButton>
              <ToggletipContent>
                <p>Card and invoice payments don't go through the register.</p>
                <p>Everything in cash from the beginning up to {range.valid ? 'the end of the period' : 'the chosen end'}.</p>
                <dl className="sales-sum">
                  <div><dt>Cash receipts</dt><dd>{formatEur(register.receipts)}</dd></div>
                  <div><dt>− Cash refunds and corrections</dt><dd>{formatEur(register.refunds)}</dd></div>
                  <div><dt>− Cash withdrawals</dt><dd>{formatEur(register.withdrawals)}</dd></div>
                  <div><dt>+ Cash deposits</dt><dd>{formatEur(register.deposits)}</dd></div>
                  <div className="sales-sum__total"><dt>Expected in the register</dt><dd>{formatEur(register.expected)}</dd></div>
                </dl>
              </ToggletipContent>
            </Toggletip>
          </span>
          <span className="sales-tile__value">{range.valid ? formatEur(register.expected) : '—'}</span>
          <span className="mj-secondary">{range.valid ? `After ${register.withdrawals ? 'withdrawals and ' : ''}deposits, to the end of ${range.label.toLowerCase()}` : 'Choose both dates'}</span>
        </Tile>
      </section>

      <TableContainer className="mj-table-container">
        <TableToolbar aria-label="Payments table toolbar">
          <TableToolbarContent>
            <TableToolbarSearch key={searchKey} id="payments-search" labelText="Search payments" placeholder="Search payment, order, customer or reference" defaultValue={search} onChange={(_event, value) => update({ q: value ?? '' })} onClear={() => update({ q: null })} />
            <BatchFilter
              id="payments" label="Payments" applied={appliedFilters} onApply={(values) => update(toPatch(values, [...FILTER_KEYS]))} onReset={() => update(Object.fromEntries(FILTER_KEYS.map((key) => [key, null])))}
              categories={[
                {
                  key: 'period', label: 'Period', keys: ['period', 'from', 'to'],
                  render: ({ idPrefix, staged, set }) => {
                    const chosen = staged.period?.[0] ?? 'today';
                    const [stagedFrom, stagedTo] = [staged.from?.[0] ?? '', staged.to?.[0] ?? ''];
                    return (
                      <>
                        <RadioButtonGroup legendText={<span className="cds--visually-hidden">Period</span>} name={`${idPrefix}-preset`} orientation="vertical" valueSelected={chosen}
                          onChange={(value) => { set('period', value === 'today' ? [] : [String(value)]); if (value !== 'custom') { set('from', []); set('to', []); } }}>
                          {periodPresets.map((item) => <RadioButton key={item.id} id={`${idPrefix}-${item.id}`} value={item.id} labelText={item.label} />)}
                        </RadioButtonGroup>
                        {chosen === 'custom' && (
                          <>
                            <DateInput id={`${idPrefix}-from`} labelText="From" value={stagedFrom} onChange={(value) => set('from', value ? [value] : [])} invalid={!!stagedFrom && !!stagedTo && stagedFrom > stagedTo} invalidText="Start must not be after the end" />
                            <DateInput id={`${idPrefix}-to`} labelText="Through" value={stagedTo} onChange={(value) => set('to', value ? [value] : [])} />
                          </>
                        )}
                      </>
                    );
                  },
                },
                { key: 'method', label: 'Method', options: methodFilterOptions },
                { key: 'kind', label: 'Kind', options: KIND_OPTIONS },
                { key: 'who', label: 'Customer', options: WHO_OPTIONS },
              ]}
            />
            {canRecord && (
              <>
                <Button kind="ghost" size="md" renderIcon={Subtract} onClick={() => setMovement('withdrawal')}>Record cash withdrawal</Button>
                <Button kind="ghost" size="md" renderIcon={Add} onClick={() => setMovement('deposit')}>Record cash deposit</Button>
              </>
            )}
            <span className="sales-export">
              <Button kind="ghost" size="md" renderIcon={Download} disabled={visible.length === 0} onClick={() => { exportLines(visible, filename); store.notify({ kind: 'success', title: 'CSV exported', subtitle: `${visible.length} ${visible.length === 1 ? 'line' : 'lines'} of the current view were saved as ${filename}.` }); }}>Export CSV</Button>
            </span>
          </TableToolbarContent>
        </TableToolbar>
        <Table aria-label="Cashbook">
          <TableHead>
            <TableRow>
              <TableHeader>Time</TableHeader><TableHeader>Payment</TableHeader><TableHeader>Order and customer</TableHeader><TableHeader className="mj-hide-narrow">Method</TableHeader>
              <TableHeader className="sales-num">Amount</TableHeader><TableHeader className="mj-hide-narrow">Recorded by</TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((line) => line.type === 'payment' ? (
              <TableRow key={line.id} className="mj-table-row" onClick={() => navigate(`/sales/payments/${line.payment.id}`)}>
                <TableCell>{formatDateTime(line.at)}</TableCell>
                <TableCell>
                  <div className="mj-cell-stack">
                    <RefLink reference={line.reference} id={line.payment.id} />
                    <PaymentKindTag payment={line.payment} />
                    <span className="mj-secondary mj-show-narrow">{methodLabel(line.method)}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="mj-cell-stack">
                    {line.order ? <RefLink reference={line.order.reference} id={line.order.id} /> : '—'}
                    {line.order && <CarbonLink as={Link} to={`/sales/orders?customer=${line.order.customer.id}`} onClick={(event: React.MouseEvent) => event.stopPropagation()}>{line.customerLabel}</CarbonLink>}
                  </div>
                </TableCell>
                <TableCell className="mj-hide-narrow">{methodLabel(line.method)}</TableCell>
                <TableCell className={`sales-num${line.signed < 0 ? ' sales-num--due' : ''}`}>{amountText(line)}</TableCell>
                <TableCell className="mj-hide-narrow">{line.recordedBy}</TableCell>
              </TableRow>
            ) : (
              <TableRow key={line.id}>
                <TableCell>{formatDateTime(line.at)}</TableCell>
                <TableCell>
                  <div className="mj-cell-stack">
                    <strong>{line.reference}</strong>
                    <MovementKindTag movement={line.movement} />
                    <span className="mj-secondary mj-show-narrow">{methodLabel(line.method)}</span>
                  </div>
                </TableCell>
                <TableCell><div className="mj-cell-stack"><span className="mj-secondary">Not tied to an order</span><span>{cashMovementReasonLabel[line.movement.reason]}{line.movement.note ? ` · ${line.movement.note}` : ''}</span></div></TableCell>
                <TableCell className="mj-hide-narrow">{methodLabel(line.method)}</TableCell>
                <TableCell className={`sales-num${line.signed < 0 ? ' sales-num--due' : ''}`}>{amountText(line)}</TableCell>
                <TableCell className="mj-hide-narrow">{line.recordedBy}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {visible.length === 0 && (range.valid && (empty || (inPeriod.length === 0 && !search && activeFilters === 0))
          ? <EmptyState title={empty ? 'No payments yet' : 'No payments in this period'} description={empty ? 'Receipts, refunds and corrections appear here as soon as they are recorded.' : 'Pick another period to see earlier payments.'} />
          : <EmptyState title="No payments found" description={range.valid ? 'Try different search terms or filters.' : 'Choose a start and an end date.'} action={range.valid ? <Button kind="tertiary" onClick={clearAll}>Clear filters</Button> : undefined} />)}
        <Pagination page={page} pageSize={pageSize} pageSizes={PAGE_SIZES} totalItems={visible.length} onChange={({ page: nextPage, pageSize: nextSize }) => update({ page: String(nextPage), pageSize: String(nextSize) })} />
        {movement && <CashMovementModal kind={movement} onClose={() => setMovement(null)} />}
      </TableContainer>
    </div>
  );
}

export function PaymentsPage() {
  const store = useStore();
  const { query, data } = useSalesData();
  const lines = useMemo(() => cashbookLines(data.payments, data.allocations, data.orders, data.cashMovements), [data.payments, data.allocations, data.orders, data.cashMovements]);
  return (
    <RequirePermission permission="payments.read" title="Payments" crumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Payments' }]}>
      <PageShell title="Payments" description="The cashbook: every receipt, refund, correction and cash movement." width="wide" breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Payments' }]}>
        <QueryBoundary query={query} errorMessage="The payments could not be loaded.">
          <Cashbook lines={lines} empty={store.scenario === 'empty'} canRecord={store.can('payments.record')} payments={data.payments} movements={data.cashMovements} />
        </QueryBoundary>
      </PageShell>
    </RequirePermission>
  );
}
