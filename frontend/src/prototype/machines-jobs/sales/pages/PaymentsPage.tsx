import { useMemo, useState } from 'react';
import {
  Button, Checkbox, CheckboxGroup, ContentSwitcher, Link as CarbonLink, Pagination, Popover, PopoverContent, Select, SelectItem, Switch, Tab, Table, TableBody, TableCell, TableContainer,
  TableHead, TableHeader, TableRow, TableToolbar, TableToolbarContent, TableToolbarSearch, TabList, TabPanel, TabPanels, Tabs, Tag, Tile,
} from '@carbon/react';
import { Download, Filter, Locked } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import { DateInput } from '../../../../app/DateInput';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { timeInAppTimeZone } from '../../../../app/dateTime';
import { QueryBoundary } from '../../components/QueryBoundary';
import { useStore } from '../../store';
import { DayClosePanel } from '../components/DayClosePanel';
import { RequirePermission } from '../components/RequirePermission';
import { downloadCsv, toCsv } from '../csv';
import { dateInAppTimeZone, formatDateTime, formatEur, formatSignedEur, round2 } from '../format';
import { customerKindLabel, methodLabel, methodOptions, paymentKind, reasonKindLabel } from '../labels';
import { cashbookLines, periodPresets, periodRange, takings, type CashbookLine, type PeriodPreset } from '../logic';
import { PaymentKindTag, ProposedTag } from '../status';
import { useSalesData } from '../useSalesData';
import { useUrlParams } from '../useUrlParams';
import type { PaymentMethod } from '../types';
import '../sales.scss';

const PAGE_SIZES = [10, 25, 50];
const FILTER_KEYS = ['method', 'kind', 'who'] as const;
const KIND_OPTIONS = [{ id: 'receipt', label: 'Receipt' }, { id: 'refund', label: 'Refund' }, { id: 'correction', label: 'Correction' }];
const WHO_OPTIONS = [{ id: 'person', label: 'Person' }, { id: 'organization', label: 'Organization' }, { id: 'walk_in', label: 'Walk-in customer' }];
const kindId = (line: CashbookLine) => paymentKind(line.payment).label.toLowerCase();

function amountText(line: CashbookLine) {
  return line.payment.entryKind === 'reversal' ? formatSignedEur(line.signed) : formatEur(line.signed);
}

/** The cashbook as a spreadsheet file. Amounts are plain numbers with a decimal point so any tool can add them up. */
function exportLines(lines: CashbookLine[], filename: string) {
  const rows = lines.map((line) => [
    line.payment.reference, dateInAppTimeZone(line.payment.occurredAt), timeInAppTimeZone(line.payment.occurredAt), paymentKind(line.payment).label, methodLabel(line.payment.method), line.signed.toFixed(2),
    line.order?.reference ?? '', line.order?.customerName ?? (line.order ? 'Walk-in customer' : ''), line.payment.terminal, line.payment.transactionReference,
    line.payment.reasonKind ? reasonKindLabel(line.payment.reasonKind) : '', line.payment.reason, line.payment.recordedBy, dateInAppTimeZone(line.payment.recordedAt),
  ]);
  downloadCsv(filename, toCsv(['Payment', 'Date', 'Time', 'Kind', 'Method', 'Amount EUR', 'Order', 'Customer', 'Terminal', 'Transaction reference', 'Reason kind', 'Reason', 'Recorded by', 'Recorded on'], rows));
}

function Cashbook({ lines, empty }: { lines: CashbookLine[]; empty: boolean }) {
  const store = useStore();
  const navigate = useNavigate();
  const { params, update, list, toggleIn } = useUrlParams();
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchKey, setSearchKey] = useState(0);
  const preset = (periodPresets.find((item) => item.id === params.get('period'))?.id ?? 'today') as PeriodPreset;
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const search = params.get('q') ?? '';
  const methods = list('method'); const kinds = list('kind'); const who = list('who');
  const activeFilters = FILTER_KEYS.filter((key) => params.get(key)).length;
  const range = periodRange(preset, from, to);

  const inPeriod = useMemo(() => range.valid ? lines.filter((line) => { const at = new Date(line.payment.occurredAt).getTime(); return at >= range.from && at < range.to; }) : [], [lines, range.from, range.to, range.valid]);
  const tiles = useMemo(() => {
    const net = takings(inPeriod.map((line) => line.payment), range.from, range.to);
    const count = (method: PaymentMethod | null) => {
      const mine = inPeriod.filter((line) => method === null || line.payment.method === method);
      const receipts = mine.filter((line) => line.payment.entryKind === 'receipt').length; const undone = mine.length - receipts;
      return `${receipts} ${receipts === 1 ? 'receipt' : 'receipts'} · ${undone} ${undone === 1 ? 'refund or correction' : 'refunds or corrections'}`;
    };
    return [
      { key: 'total', label: 'Net takings', value: net.total, detail: count(null) },
      { key: 'cash', label: 'Cash', value: net.cash, detail: count('cash') },
      { key: 'card', label: 'Card', value: net.card, detail: count('card') },
      { key: 'external', label: 'Bank transfer (wiRef)', value: net.external, detail: count('external') },
    ];
  }, [inPeriod, range.from, range.to]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return inPeriod.filter((line) => (methods.length === 0 || methods.includes(line.payment.method)) && (kinds.length === 0 || kinds.includes(kindId(line))) && (who.length === 0 || who.includes(line.customerKind))
      && (!needle || `${line.payment.reference} ${line.order?.reference ?? ''} ${line.customerLabel} ${line.payment.transactionReference} ${line.payment.recordedBy}`.toLowerCase().includes(needle)));
  }, [inPeriod, search, methods.join(','), kinds.join(','), who.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const pageSize = PAGE_SIZES.includes(Number(params.get('pageSize'))) ? Number(params.get('pageSize')) : 10;
  const page = Math.max(1, Math.min(Number(params.get('page')) || 1, Math.ceil(visible.length / pageSize) || 1));
  const rows = visible.slice((page - 1) * pageSize, page * pageSize);
  const clearAll = () => { update({ ...Object.fromEntries(FILTER_KEYS.map((key) => [key, null])), q: null }); setSearchKey((value) => value + 1); };
  const setPreset = (id: PeriodPreset) => update({ period: id === 'today' ? null : id, ...(id === 'custom' ? {} : { from: null, to: null }) });
  const filename = `cashbook-${preset === 'custom' ? `${from}_${to}` : dateInAppTimeZone(new Date(range.from))}.csv`;

  return (
    <div className="mj-stack">
      <div className="sales-period">
        <div className="mj-hide-narrow">
          <ContentSwitcher size="md" selectedIndex={periodPresets.findIndex((item) => item.id === preset)} onChange={({ index }) => setPreset(periodPresets[index ?? 0].id)}>
            {periodPresets.map((item) => <Switch key={item.id} name={item.id} text={item.label} />)}
          </ContentSwitcher>
        </div>
        <div className="mj-show-narrow">
          <Select id="payments-period" labelText="Period" value={preset} onChange={(event) => setPreset(event.target.value as PeriodPreset)}>
            {periodPresets.map((item) => <SelectItem key={item.id} value={item.id} text={item.label} />)}
          </Select>
        </div>
        {preset === 'custom' && (
          <div className="sales-period__range">
            <DateInput id="payments-from" labelText="From" value={from} onChange={(value) => update({ from: value || null })} invalid={!!from && !!to && from > to} invalidText="Start must not be after the end" />
            <DateInput id="payments-to" labelText="Through" value={to} onChange={(value) => update({ to: value || null })} />
          </div>
        )}
      </div>

      <section className="sales-tiles" aria-label="Takings by method">
        {tiles.map((tile) => (
          <Tile key={tile.key} className="sales-tile">
            <span className="sales-tile__label">{tile.label}</span>
            <span className="sales-tile__value">{range.valid ? formatEur(round2(tile.value)) : '—'}</span>
            <span className="mj-secondary">{range.valid ? tile.detail : 'Choose both dates'}</span>
          </Tile>
        ))}
      </section>

      <TableContainer className="mj-table-container">
        <TableToolbar aria-label="Payments table toolbar">
          <TableToolbarContent>
            <TableToolbarSearch key={searchKey} id="payments-search" labelText="Search payments" placeholder="Search payment, order, customer or reference" defaultValue={search} onChange={(_event, value) => update({ q: value ?? '' })} onClear={() => update({ q: null })} />
            <Popover open={filtersOpen} align="bottom-end" className="sales-filter-popover">
              <Button hasIconOnly kind={activeFilters ? 'primary' : 'ghost'} size="md" renderIcon={Filter} iconDescription={activeFilters ? `Filters (${activeFilters} active)` : 'Filters'} aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)} />
              <PopoverContent>
                <div className="sales-filters" role="group" aria-label="Payment filters">
                  <CheckboxGroup legendText="Method">
                    {methodOptions.map((option) => <Checkbox key={option.id} id={`payments-method-${option.id}`} labelText={option.label} checked={methods.includes(option.id)} onChange={(_event, { checked }) => toggleIn('method', option.id, checked)} />)}
                  </CheckboxGroup>
                  <CheckboxGroup legendText="Kind">
                    {KIND_OPTIONS.map((option) => <Checkbox key={option.id} id={`payments-kind-${option.id}`} labelText={option.label} checked={kinds.includes(option.id)} onChange={(_event, { checked }) => toggleIn('kind', option.id, checked)} />)}
                  </CheckboxGroup>
                  <CheckboxGroup legendText="Customer">
                    {WHO_OPTIONS.map((option) => <Checkbox key={option.id} id={`payments-who-${option.id}`} labelText={option.label} checked={who.includes(option.id)} onChange={(_event, { checked }) => toggleIn('who', option.id, checked)} />)}
                  </CheckboxGroup>
                  <div className="sales-filters__actions">
                    <Button kind="ghost" size="sm" disabled={activeFilters === 0} onClick={() => update(Object.fromEntries(FILTER_KEYS.map((key) => [key, null])))}>Clear filters</Button>
                    <Button kind="secondary" size="sm" onClick={() => setFiltersOpen(false)}>Done</Button>
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <span className="sales-export">
              <Button kind="ghost" size="md" renderIcon={Download} disabled={visible.length === 0} onClick={() => { exportLines(visible, filename); store.notify({ kind: 'success', title: 'CSV exported', subtitle: `${visible.length} ${visible.length === 1 ? 'line' : 'lines'} of the current view were saved as ${filename}.` }); }}>Export CSV</Button>
              <ProposedTag hint="Needs a payments export endpoint" />
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
            {rows.map((line) => (
              <TableRow key={line.payment.id} className="mj-table-row" onClick={() => navigate(`/sales/payments/${line.payment.id}`)}>
                <TableCell>{formatDateTime(line.payment.occurredAt)}</TableCell>
                <TableCell>
                  <div className="mj-cell-stack">
                    <CarbonLink as={Link} to={`/sales/payments/${line.payment.id}`} onClick={(event: React.MouseEvent) => event.stopPropagation()}>{line.payment.reference}</CarbonLink>
                    <span className="mj-inline">
                      <PaymentKindTag payment={line.payment} />
                      {line.locked && <Tag type="gray" size="sm" renderIcon={Locked} title="The cash of this day is closed">Day closed</Tag>}
                    </span>
                    <span className="mj-secondary mj-show-narrow">{methodLabel(line.payment.method)}</span>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="mj-cell-stack">
                    {line.order ? <CarbonLink as={Link} to={`/sales/orders/${line.order.id}`} onClick={(event: React.MouseEvent) => event.stopPropagation()}>{line.order.reference}</CarbonLink> : '—'}
                    {line.order?.customer
                      ? <CarbonLink as={Link} to={`/sales/customers/${line.order.customer.kind}/${line.order.customer.id}`} onClick={(event: React.MouseEvent) => event.stopPropagation()}>{line.customerLabel}</CarbonLink>
                      : <span className="mj-secondary">{customerKindLabel('walk_in')}</span>}
                  </div>
                </TableCell>
                <TableCell className="mj-hide-narrow">{methodLabel(line.payment.method)}</TableCell>
                <TableCell className={`sales-num${line.signed < 0 ? ' sales-num--due' : ''}`}>{amountText(line)}</TableCell>
                <TableCell className="mj-hide-narrow">{line.payment.recordedBy}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        {visible.length === 0 && (range.valid && (empty || (inPeriod.length === 0 && !search && activeFilters === 0))
          ? <EmptyState title={empty ? 'No payments yet' : 'No payments in this period'} description={empty ? 'Receipts, refunds and corrections appear here as soon as they are recorded.' : 'Pick another period to see earlier payments.'} />
          : <EmptyState title="No payments found" description={range.valid ? 'Try different search terms or filters.' : 'Choose a start and an end date.'} action={range.valid ? <Button kind="tertiary" onClick={clearAll}>Clear filters</Button> : undefined} />)}
        <Pagination page={page} pageSize={pageSize} pageSizes={PAGE_SIZES} totalItems={visible.length} onChange={({ page: nextPage, pageSize: nextSize }) => update({ page: String(nextPage), pageSize: String(nextSize) })} />
      </TableContainer>
    </div>
  );
}

export function PaymentsPage() {
  const store = useStore();
  const { params, update } = useUrlParams();
  const { query, data } = useSalesData();
  const lines = useMemo(() => cashbookLines(data.payments, data.allocations, data.orders, store.daySessions), [data.payments, data.allocations, data.orders, store.daySessions]);
  const tab = params.get('tab') === 'close' ? 1 : 0;
  return (
    <RequirePermission permission="payments.read" title="Payments" crumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Payments' }]}>
      <PageShell title="Payments" description="The cashbook: every receipt, refund and correction." width="wide" breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Payments' }]}>
        <QueryBoundary query={query} errorMessage="The payments could not be loaded.">
          <Tabs selectedIndex={tab} onChange={({ selectedIndex }) => update({ tab: selectedIndex === 1 ? 'close' : null, period: null, from: null, to: null, q: null, method: null, kind: null, who: null })}>
            <TabList aria-label="Payment sections" contained>
              <Tab>Cashbook</Tab>
              <Tab><span className="mj-inline">Day close <ProposedTag hint="Needs cash day sessions on the backend" /></span></Tab>
            </TabList>
            <TabPanels>
              <TabPanel className="sales-tab-panel"><Cashbook lines={lines} empty={store.scenario === 'empty'} /></TabPanel>
              <TabPanel className="sales-tab-panel"><DayClosePanel payments={data.payments} sessions={store.daySessions} canClose={store.can('payments.record')} /></TabPanel>
            </TabPanels>
          </Tabs>
        </QueryBoundary>
      </PageShell>
    </RequirePermission>
  );
}
