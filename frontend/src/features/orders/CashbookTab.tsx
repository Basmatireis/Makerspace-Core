import { useState } from 'react';
import { Button, Link as CarbonLink, OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { Download } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { FactTiles } from '../../app/components/Facts';
import { RefLink } from '../../app/RefLink';
import { formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { DirectoryTable, useUrlState, type Column } from '../machinelogbook/shared/DirectoryTable';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { ExportCashbookModal } from './ExportCashbookModal';
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
import { canPrintReceipt, cashbookLines, lineKindId, takings, type CashbookLine } from './logic';
import { formatCents, formatSignedCents } from './money';
import { periodInstants } from './period';
import { FilterTags, usePeriodFilter } from './PeriodFilter';
import { allOrdersQuery, periodMovementsQuery, periodPaymentsQuery } from './queries';
import { RefundFromList } from './RefundFromList';
import { MovementKindTag, PaymentKindTag } from './status';

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

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Every payment of the period, cash movements included, with the takings per method. */
export function CashbookTab() {
  const user = useCurrentUser();
  const periodFilter = usePeriodFilter();
  const canMovements = hasPermission(user, PermissionId.cash_movementsread);
  const range = periodInstants(periodFilter.period);
  const payments = useQuery(periodPaymentsQuery(range.from, range.to));
  const movements = useQuery({ ...periodMovementsQuery(range.from, range.to), enabled: canMovements });
  return (
    <div className="mj-stack">
      {periodFilter.note}
      <QueryBoundary query={payments} errorMessage="The payments could not be loaded.">
        {() => (
          <CashbookTable periodFilter={periodFilter} payments={payments.data ?? []} movements={movements.data ?? []} />
        )}
      </QueryBoundary>
      {periodFilter.dialog}
    </div>
  );
}

function CashbookTable({
  periodFilter,
  payments,
  movements,
}: {
  periodFilter: ReturnType<typeof usePeriodFilter>;
  payments: Parameters<typeof cashbookLines>[0];
  movements: Parameters<typeof cashbookLines>[1];
}) {
  const user = useCurrentUser();
  const navigate = useNavigate();
  const url = useUrlState('');
  const [exporting, setExporting] = useState(false);
  const [refunding, setRefunding] = useState<string | null>(null);
  const canMovements = hasPermission(user, PermissionId.cash_movementsread);
  const canOrders = hasPermission(user, PermissionId.ordersread);
  const canReverse = hasPermission(user, PermissionId.paymentsreverse);
  const orders = useQuery({ ...allOrdersQuery(), enabled: canOrders });
  const lines = cashbookLines(payments, movements, orders.data);
  const reversed = new Set(
    payments.flatMap((payment) => (payment.reversesPaymentId ? [payment.reversesPaymentId] : [])),
  );

  const methods = url.list('method');
  const kinds = url.list('kind');
  const who = url.list('who');
  const rows = lines.filter(
    (line) =>
      (methods.length === 0 || methods.includes(line.method)) &&
      (kinds.length === 0 || kinds.includes(lineKindId(line))) &&
      (who.length === 0 || (line.type === 'payment' && line.customerKind !== null && who.includes(line.customerKind))),
  );

  const net = takings(payments);
  const count = (method: string | null) => {
    const mine = payments.filter((payment) => method === null || payment.method === method);
    const receipts = mine.filter((payment) => payment.entryKind === 'receipt').length;
    return `${plural(receipts, 'receipt', 'receipts')} · ${plural(mine.length - receipts, 'refund or correction', 'refunds or corrections')}`;
  };
  const kindOptions = canMovements ? cashbookKindOptions : cashbookKindOptions.slice(0, 3);
  const categories = [
    periodFilter.category,
    { key: 'method', label: 'Method', options: methodFilterOptions },
    { key: 'kind', label: 'Kind', options: kindOptions },
    { key: 'who', label: 'Customer', options: customerTypeOptions },
  ];

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
          <div className="mj-cell-stack" data-guide={`payments-line-${line.reference}`}>
            <RefLink reference={line.reference} id={line.payment.id} kind="payment" />
            <span className="sales-inline">
              <PaymentKindTag payment={line.payment} />
              {line.payment.reversedPaymentReference && (
                <span className="mj-secondary">reverses {line.payment.reversedPaymentReference}</span>
              )}
            </span>
            <span className="mj-secondary mj-show-narrow">{methodLabel(line.method)}</span>
          </div>
        ) : (
          <div className="mj-cell-stack">
            <strong>{line.reference}</strong>
            <span>
              <MovementKindTag movement={line.movement} />
            </span>
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
            {line.order && line.customerId ? (
              <CarbonLink as={Link} to={`/orders?customer=${line.customerId}`}>
                {line.customerLabel}
              </CarbonLink>
            ) : (
              line.order && <span className="mj-secondary">{line.customerLabel}</span>
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
    {
      key: 'method',
      header: 'Method',
      narrow: true,
      render: (line) => (
        <div className="mj-cell-stack">
          <span>{methodLabel(line.method)}</span>
          {line.type === 'payment' && line.method === 'card' && line.payment.externalSource && (
            <span className="mj-secondary">{line.payment.externalSource}</span>
          )}
        </div>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      className: 'sales-num',
      sortValue: (line) => line.signed,
      firstDirection: 'DESC',
      render: (line) => <span className={line.signed < 0 ? 'sales-num--due' : undefined}>{amountText(line)}</span>,
    },
    { key: 'by', header: 'Recorded by', narrow: true, render: (line) => line.recordedBy },
    {
      key: 'actions',
      header: 'Actions',
      hiddenHeader: true,
      className: 'sales-row-actions',
      render: (line) => {
        if (line.type !== 'payment') return null;
        const receipt = line.payment.entryKind === 'receipt';
        const printable = receipt && canOrders && line.order && canPrintReceipt(line.order);
        return (
          <OverflowMenu
            size="sm"
            flipped
            iconDescription={`Actions for ${line.reference}`}
            aria-label={`Actions for ${line.reference}`}
          >
            <OverflowMenuItem itemText="Open payment" onClick={() => void navigate(`/payments/${line.payment.id}`)} />
            {canOrders && line.orderId && (
              <OverflowMenuItem itemText="Open order" onClick={() => void navigate(`/orders/${line.orderId}`)} />
            )}
            {printable && (
              <OverflowMenuItem
                itemText="Show receipt"
                onClick={() => void navigate(`/orders/${line.orderId}/receipt?payment=${line.payment.id}`)}
              />
            )}
            {receipt && canReverse && canOrders && line.orderId && (
              <OverflowMenuItem
                hasDivider
                isDelete
                itemText="Refund or correct…"
                disabled={reversed.has(line.payment.id)}
                onClick={() => setRefunding(line.payment.id)}
              />
            )}
          </OverflowMenu>
        );
      },
    },
  ];

  return (
    <>
      <FactTiles
        label="Takings by method"
        items={[
          { id: 'total', label: 'Net takings', value: formatCents(net.total), helper: count(null) },
          { id: 'cash', label: 'Cash', value: formatCents(net.cash), helper: count('cash') },
          { id: 'card', label: 'Card', value: formatCents(net.card), helper: count('card') },
          { id: 'external', label: 'Invoice (wiRef)', value: formatCents(net.external), helper: count('external') },
        ]}
      />
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
          if (line.type === 'payment') void navigate(`/payments/${line.payment.id}`);
        }}
        switcher={<FilterTags period={periodFilter.tag} categories={categories} />}
        filterCategories={categories}
        toolbarAction={
          canMovements ? (
            <Button kind="ghost" size="md" renderIcon={Download} onClick={() => setExporting(true)}>
              Export
            </Button>
          ) : undefined
        }
        empty={{
          title: 'No payments in this period',
          description: 'Pick another period to see earlier payments.',
        }}
      />
      {exporting && (
        <ExportCashbookModal period={periodFilter.period} contents="all_payments" onClose={() => setExporting(false)} />
      )}
      {refunding && <RefundFromList paymentId={refunding} onClose={() => setRefunding(null)} />}
    </>
  );
}
