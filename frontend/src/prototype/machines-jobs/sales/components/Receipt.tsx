import { RefLink } from '../../components/RefLink';
import { Button, Tag } from '@carbon/react';
import { Printer } from '@carbon/icons-react';
import { activeItems } from '../logic';
import { formatDateTime, formatEur, formatQuantity } from '../format';
import { methodLabel } from '../labels';
import { ProposedTag } from '../status';
import type { OrderView } from '../logic';
import type { Payment } from '../types';

export type ReceiptChange = { tendered: number; change: number } | null;

/** A paper-style receipt. Printing hides everything else on the page (see sales.scss). [proposed] receipt numbering and a PDF export. */
export function ReceiptPreview({ order, payments, operator, change }: { order: OrderView; payments: Payment[]; operator?: string; change?: ReceiptChange }) {
  const items = activeItems(order);
  return (
    <div className="sales-receipt-wrap">
      <article className="sales-receipt" aria-label={`Receipt for ${order.reference}`}>
        <header className="sales-receipt__head">
          <strong>Makerspace Core</strong>
          <span>Receipt for <RefLink reference={order.reference} id={order.id} /></span>
          <span>{formatDateTime(payments[0]?.occurredAt ?? order.updatedAt)}</span>
          {operator && <span>Served by {operator}</span>}
        </header>
        <ul className="sales-receipt__lines">
          {items.map((item) => (
            <li key={item.id}>
              <span>{item.description}{item.kind === 'manual' && item.quantity !== 1 ? ` (${formatQuantity(item.quantity)} ${item.unit} × ${formatEur(item.unitPrice)})` : ''}</span>
              <span>{formatEur(item.amount)}</span>
            </li>
          ))}
        </ul>
        <div className="sales-receipt__total"><span>Total</span><span>{formatEur(order.net)}</span></div>
        {order.net === 0 ? <p className="sales-receipt__note">Free of charge, no payment due.</p> : (
          <ul className="sales-receipt__lines">
            {payments.map((payment) => <li key={payment.id}><span>{methodLabel(payment.method)} · <RefLink reference={payment.reference} id={payment.id} /></span><span>{formatEur(payment.amount)}</span></li>)}
            {change && <><li><span>Handed over</span><span>{formatEur(change.tendered)}</span></li><li><span>Change</span><span>{formatEur(change.change)}</span></li></>}
          </ul>
        )}
        <footer className="sales-receipt__foot">Thank you for your visit.<br />This is a payment receipt, not an invoice.</footer>
      </article>
      <div className="sales-receipt-actions">
        <Button kind="tertiary" renderIcon={Printer} onClick={() => window.print()}>Print receipt</Button>
        <span className="mj-inline"><Tag type="outline" size="sm">Preview</Tag><ProposedTag hint="Needs receipt numbering and a PDF export" /><span className="mj-secondary">Receipt numbering and PDF</span></span>
      </div>
    </div>
  );
}
