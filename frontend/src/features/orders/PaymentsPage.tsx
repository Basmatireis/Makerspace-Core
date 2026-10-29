import { useState } from 'react';
import {
  Button,
  Link as CarbonLink,
  RadioButton,
  RadioButtonGroup,
  Tile,
  Toggletip,
  ToggletipButton,
  ToggletipContent,
} from '@carbon/react';
import { Add, Download, Information, Subtract } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { CashMovementKind } from '../../api/generated/models';
import { DateInput } from '../../app/DateInput';
import { PageShell } from '../../app/PageShell';
import { RefLink } from '../../app/RefLink';
import { dateInAppTimeZone, formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { DirectoryTable, useUrlState, type Column } from '../machinelogbook/shared/DirectoryTable';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { useNotify } from '../machinelogbook/shared/toasts';
import { CashMovementModal } from './CashMovementModal';
import { downloadCsv } from './csv';
import { cashbookCsv } from './cashbookCsv';
import {
  cashbookKindOptions,
  cashMovementKindLabel,
  cashMovementReasonLabel,
  customerTypeOptions,
  methodFilterOptions,
  methodLabel,
  paymentKind,
  reasonKindLabel,
} from './labels';
import {
  cashbookLines,
  lineKindId,
  defaultPeriodPreset,
  periodPresets,
  periodRange,
  periodText,
  takings,
  type CashbookLine,
  type PeriodPreset,
} from './logic';
import { formatCents, formatSignedCents, toCents } from './money';
import { allOrdersQuery, cashRegisterQuery, periodMovementsQuery, periodPaymentsQuery } from './queries';
import { MovementKindTag, PaymentKindTag } from './status';
import './sales.scss';
import '../machinelogbook/shared/shared.scss';

const amountText = (line: CashbookLine) =>
  line.type === 'movement' || line.payment.entryKind === 'reversal'
    ? formatSignedCents(line.signed)
    : formatCents(line.signed);

/** What the search matches: reference, kind and method labels, the order and customer, reasons, notes, sources and who recorded it. */
function lineSearchText(line: CashbookLine) {
  const parts =
    line.type === 'payment'
      ? [
          line.orderReference,
          line.customerLabel,
          paymentKind(line.payment).label,
          line.payment.entryKind === 'receipt' ? null : reasonKindLabel(line.payment.reasonKind),
          line.payment.reason,
          line.payment.reversedPaymentReference,
          line.payment.externalSource,
          line.payment.externalReference,
        ]
      : [cashMovementKindLabel(line.movement.kind), cashMovementReasonLabel[line.movement.reason], line.movement.note];
  return [line.reference, ...parts, methodLabel(line.method), line.recordedBy].filter(Boolean).join(' ');
}

function Cashbook() {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const notify = useNotify();
  const url = useUrlState('');
  const [movement, setMovement] = useState<CashMovementKind | null>(null);
  const canMovements = hasPermission(user, PermissionId.cash_movementsread);
  const canRecord = hasPermission(user, PermissionId.cash_movementsrecord);
  const canOrders = hasPermission(user, PermissionId.ordersread);
  const preset = (periodPresets.find((item) => item.id === url.get('period'))?.id ??
    defaultPeriodPreset) as PeriodPreset;
  const from = url.get('from');
  const to = url.get('to');
  const range = periodRange(preset, from, to);
  const fromIso = new Date(range.from).toISOString();
  const toIso = new Date(range.to).toISOString();

  const payments = useQuery({ ...periodPaymentsQuery(fromIso, toIso), enabled: range.valid });
  const movements = useQuery({ ...periodMovementsQuery(fromIso, toIso), enabled: range.valid && canMovements });
  const register = useQuery({ ...cashRegisterQuery(toIso), enabled: range.valid && canMovements });
  const orders = useQuery({ ...allOrdersQuery(), enabled: canOrders });
  const lines = cashbookLines(payments.data ?? [], movements.data ?? [], orders.data);

  const methods = url.list('method');
  const kinds = url.list('kind');
  const who = url.list('who');
  const rows = lines.filter(
    (line) =>
      (methods.length === 0 || methods.includes(line.method)) &&
      (kinds.length === 0 || kinds.includes(lineKindId(line))) &&
      (who.length === 0 || (line.type === 'payment' && line.customerKind !== null && who.includes(line.customerKind))),
  );

  const paymentList = payments.data ?? [];
  const net = takings(paymentList);
  const count = (method: string | null) => {
    const mine = paymentList.filter((payment) => method === null || payment.method === method);
    const receipts = mine.filter((payment) => payment.entryKind === 'receipt').length;
    const undone = mine.length - receipts;
    return `${receipts} ${receipts === 1 ? 'receipt' : 'receipts'} · ${undone} ${undone === 1 ? 'refund or correction' : 'refunds or corrections'}`;
  };
  const tiles = [
    { key: 'total', label: 'Net takings', value: net.total, detail: count(null) },
    { key: 'cash', label: 'Cash', value: net.cash, detail: count('cash') },
    { key: 'card', label: 'Card', value: net.card, detail: count('card') },
    { key: 'external', label: 'Invoice (wiRef)', value: net.external, detail: count('external') },
  ];
  const figures = register.data;
  const filename = `cashbook-${
    preset === 'custom'
      ? `${from}_${to}`
      : preset === 'all'
        ? `until-${dateInAppTimeZone(new Date(range.to - 1))}`
        : dateInAppTimeZone(new Date(range.from))
  }.csv`;

  const columns: Column<CashbookLine>[] = [
    {
      key: 'time',
      header: 'Time',
      sortValue: (line) => line.at,
      firstDirection: 'DESC',
      render: (line) => formatDateTime(line.at),
    },
    {
      key: 'payment',
      header: 'Payment',
      render: (line) =>
        line.type === 'payment' ? (
          <div className="mj-cell-stack">
            <RefLink reference={line.reference} id={line.payment.id} kind="payment" />
            <PaymentKindTag payment={line.payment} />
            <span className="mj-secondary mj-show-narrow">{methodLabel(line.method)}</span>
          </div>
        ) : (
          <div className="mj-cell-stack">
            <strong>{line.reference}</strong>
            <MovementKindTag movement={line.movement} />
            <span className="mj-secondary mj-show-narrow">{methodLabel(line.method)}</span>
          </div>
        ),
    },
    {
      key: 'order',
      header: 'Order and customer',
      render: (line) =>
        line.type === 'payment' ? (
          <div className="mj-cell-stack">
            {line.orderReference ? <RefLink reference={line.orderReference} id={line.orderId} kind="order" /> : '—'}
            {line.order && line.customerId && (
              <CarbonLink as={Link} to={`/orders?customer=${line.customerId}`}>
                {line.customerLabel}
              </CarbonLink>
            )}
          </div>
        ) : (
          <div className="mj-cell-stack">
            <span className="mj-secondary">Not tied to an order</span>
            <span>
              {cashMovementReasonLabel[line.movement.reason]}
              {line.movement.note ? ` · ${line.movement.note}` : ''}
            </span>
          </div>
        ),
    },
    { key: 'method', header: 'Method', narrow: true, render: (line) => methodLabel(line.method) },
    {
      key: 'amount',
      header: 'Amount',
      sortValue: (line) => line.signed,
      firstDirection: 'DESC',
      render: (line) => (
        <span className={`sales-num${line.signed < 0 ? ' sales-num--due' : ''}`}>{amountText(line)}</span>
      ),
    },
    { key: 'by', header: 'Recorded by', narrow: true, render: (line) => line.recordedBy },
  ];

  return (
    <div className="mj-stack">
      <p className="sales-period-note" aria-live="polite">
        <strong>{periodText(preset, range, from, to)}</strong>
      </p>
      <section className="sales-tiles" aria-label="Takings by method">
        {tiles.map((tile) => (
          <Tile key={tile.key} className="sales-tile">
            <span className="sales-tile__label">{tile.label}</span>
            <span className="sales-tile__value">{range.valid ? formatCents(tile.value) : '—'}</span>
            <span className="mj-secondary">{range.valid ? tile.detail : 'Choose both dates'}</span>
          </Tile>
        ))}
        {canMovements && (
          <Tile className="sales-tile">
            <span className="sales-tile__label mj-inline">
              Cash in register (expected)
              <Toggletip align="bottom-start">
                <ToggletipButton label="Show how the expected cash is calculated">
                  <Information />
                </ToggletipButton>
                <ToggletipContent>
                  <p>Cash only. Card and invoice payments never go through the register.</p>
                  <p>Everything in cash from the beginning up to the end of the period.</p>
                  {figures && (
                    <dl className="sales-sum">
                      <div>
                        <dt>Cash receipts</dt>
                        <dd>{formatCents(toCents(figures.receipts))}</dd>
                      </div>
                      <div>
                        <dt>− Cash refunds and corrections</dt>
                        <dd>{formatCents(toCents(figures.refunds))}</dd>
                      </div>
                      <div>
                        <dt>− Cash withdrawals</dt>
                        <dd>{formatCents(toCents(figures.withdrawals))}</dd>
                      </div>
                      <div>
                        <dt>+ Cash deposits</dt>
                        <dd>{formatCents(toCents(figures.deposits))}</dd>
                      </div>
                      <div className="sales-sum__total">
                        <dt>Expected in the register</dt>
                        <dd>{formatCents(toCents(figures.expected))}</dd>
                      </div>
                    </dl>
                  )}
                </ToggletipContent>
              </Toggletip>
            </span>
            <span className="sales-tile__value">
              {range.valid && figures ? formatCents(toCents(figures.expected)) : '—'}
            </span>
            <span className="mj-secondary">
              {range.valid
                ? preset === 'all'
                  ? 'Up to now, after withdrawals and deposits'
                  : `To the end of ${range.label.toLowerCase()}, after withdrawals and deposits`
                : 'Choose both dates'}
            </span>
          </Tile>
        )}
      </section>
      <DirectoryTable<CashbookLine>
        id="payments"
        urlPrefix=""
        label="Payments"
        columns={columns}
        rows={rows}
        totalCount={lines.length}
        searchText={lineSearchText}
        defaultSort={{ key: 'time', direction: 'DESC' }}
        pageSizes={[10, 25, 50]}
        onRowClick={(line) => {
          if (line.type === 'payment') navigate(`/payments/${line.payment.id}`);
        }}
        filterCategories={[
          {
            key: 'period',
            label: 'Period',
            keys: ['period', 'from', 'to'],
            render: ({ idPrefix, staged, set }) => {
              const chosen = staged.period?.[0] ?? defaultPeriodPreset;
              const [stagedFrom, stagedTo] = [staged.from?.[0] ?? '', staged.to?.[0] ?? ''];
              return (
                <>
                  <RadioButtonGroup
                    legendText={<span className="cds--visually-hidden">Period</span>}
                    name={`${idPrefix}-preset`}
                    orientation="vertical"
                    valueSelected={chosen}
                    onChange={(value) => {
                      set('period', value === defaultPeriodPreset ? [] : [String(value)]);
                      if (value !== 'custom') {
                        set('from', []);
                        set('to', []);
                      }
                    }}
                  >
                    {periodPresets.map((item) => (
                      <RadioButton key={item.id} id={`${idPrefix}-${item.id}`} value={item.id} labelText={item.label} />
                    ))}
                  </RadioButtonGroup>
                  {chosen === 'custom' && (
                    <>
                      <DateInput
                        id={`${idPrefix}-from`}
                        labelText="From"
                        value={stagedFrom}
                        onChange={(value) => set('from', value ? [value] : [])}
                        invalid={!!stagedFrom && !!stagedTo && stagedFrom > stagedTo}
                        invalidText="Start must not be after the end"
                      />
                      <DateInput
                        id={`${idPrefix}-to`}
                        labelText="Through"
                        value={stagedTo}
                        onChange={(value) => set('to', value ? [value] : [])}
                      />
                    </>
                  )}
                </>
              );
            },
          },
          { key: 'method', label: 'Method', options: methodFilterOptions },
          { key: 'kind', label: 'Kind', options: canMovements ? cashbookKindOptions : cashbookKindOptions.slice(0, 3) },
          { key: 'who', label: 'Customer', options: customerTypeOptions },
        ]}
        toolbarAction={
          <>
            {canRecord && (
              <>
                <Button kind="ghost" size="md" renderIcon={Subtract} onClick={() => setMovement('withdrawal')}>
                  Record cash withdrawal
                </Button>
                <Button kind="ghost" size="md" renderIcon={Add} onClick={() => setMovement('deposit')}>
                  Record cash deposit
                </Button>
              </>
            )}
            <span className="sales-export">
              <Button
                kind="ghost"
                size="md"
                renderIcon={Download}
                disabled={rows.length === 0}
                onClick={() => {
                  downloadCsv(filename, cashbookCsv(rows));
                  notify({
                    kind: 'success',
                    title: 'CSV exported',
                    subtitle: `${rows.length} ${rows.length === 1 ? 'line' : 'lines'} of the current view were saved as ${filename}.`,
                  });
                }}
              >
                Export CSV
              </Button>
            </span>
          </>
        }
        empty={{
          title: range.valid ? 'No payments in this period' : 'Choose a start and an end date',
          description: range.valid
            ? 'Pick another period to see earlier payments.'
            : 'A custom period needs both dates.',
        }}
      />
      {movement && <CashMovementModal kind={movement} onClose={() => setMovement(null)} />}
    </div>
  );
}

export function PaymentsPage() {
  const user = useCurrentUser();
  const url = useUrlState('');
  const range = periodRange(
    (periodPresets.find((item) => item.id === url.get('period'))?.id ?? defaultPeriodPreset) as PeriodPreset,
    url.get('from'),
    url.get('to'),
  );
  const payments = useQuery({
    ...periodPaymentsQuery(new Date(range.from).toISOString(), new Date(range.to).toISOString()),
    enabled: range.valid && hasPermission(user, PermissionId.paymentsread),
  });
  return (
    <PageShell
      className="sales-page"
      title="Payments"
      description="The cashbook: every receipt, refund, correction and cash movement."
      width="wide"
      breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Payments' }]}
    >
      <QueryBoundary
        query={range.valid ? payments : { status: 'success', data: [], refetch: payments.refetch }}
        errorMessage="The payments could not be loaded."
      >
        <Cashbook />
      </QueryBoundary>
    </PageShell>
  );
}
