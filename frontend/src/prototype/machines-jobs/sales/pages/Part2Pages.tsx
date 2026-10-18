// PART 2 PLACEHOLDERS. Payments (cashbook), Invoicing (wiRef), Customers and Pricing are built in part 2 of the sales redesign
// (see SALES_DESIGN.md, "Part 2"). Each page below only states what is coming and links to what already exists, so every
// navigation item and cross-link from the order screens resolves. Replace each export with the real page in part 2.
import type { ReactNode } from 'react';
import { Button, ContainedList, ContainedListItem, InlineNotification, Tag, Tile } from '@carbon/react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageShell } from '../../../../app/PageShell';
import { useStore, type Permission } from '../../store';
import { RequirePermission } from '../components/RequirePermission';
import { formatEur } from '../format';
import { requestNextStep } from '../labels';
import { RequestStateTag } from '../status';
import '../sales.scss';

function Part2({ title, permission, description, planned, children }: { title: string; permission: Permission; description: string; planned: string[]; children?: ReactNode }) {
  return (
    <RequirePermission permission={permission} title={title} crumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: title }]}>
      <PageShell title={title} description={description} width="wide" breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: title }]}>
        <div className="mj-stack">
          <InlineNotification kind="info" lowContrast hideCloseButton title="Part 2 of the sales redesign" subtitle="This page is built in the next step. The order and counter sale screens already link here." />
          <Tile>
            <h2 className="mj-section-title">What this page will do</h2>
            <ul className="sales-planned">{planned.map((item) => <li key={item}>{item}</li>)}</ul>
          </Tile>
          {children}
        </div>
      </PageShell>
    </RequirePermission>
  );
}

export const PaymentsPlaceholder = () => (
  <Part2 title="Payments" permission="payments.read" description="The cashbook: every receipt, refund and correction."
    planned={['Takings per method for today, yesterday, this week, this month or a custom period', 'Table with payment reference, order and customer, method, kind and signed amount', 'Payment detail with the allocation history in plain words and a guided Refund or correct', 'Export as CSV (proposed) and a day-close panel with counted cash (proposed)']} />
);

export function InvoicingPlaceholder() {
  const store = useStore();
  const navigate = useNavigate();
  const { requestId } = useParams();
  const selected = store.requests.find((request) => request.id === requestId);
  return (
    <Part2 title="Invoicing" permission="external_invoice_requests.read" description="wiRef invoice requests, from preparation to the confirmed payment."
      planned={['List with search, customer, state, amount and the next step', 'Detail with a progress indicator, a readiness checklist (recipient, address, service period, purchase order) and the actions of each state', 'Humanized event history and creating a request from an order picker']}>
      {selected && (
        <Tile>
          <h2 className="mj-section-title">{selected.reference}</h2>
          <p><RequestStateTag request={selected} size="md" /> for <Link to={`/sales/orders/${selected.orderId}`}>{selected.orderReference}</Link> · {formatEur(selected.requestedAmount)}</p>
          <p className="mj-secondary">Next step: {requestNextStep[selected.state]}</p>
        </Tile>
      )}
      <ContainedList label="Requests so far" kind="on-page">
        {store.requests.length === 0 && <ContainedListItem>No wiRef request yet. Prepare one from a finalized order.</ContainedListItem>}
        {store.requests.map((request) => (
          <ContainedListItem key={request.id} onClick={() => navigate(`/sales/invoicing/${request.id}`)} action={<RequestStateTag request={request} />}>
            <span className="mj-cell-stack"><strong>{request.reference} · {request.orderReference}</strong><span className="mj-secondary">{formatEur(request.requestedAmount)} · {request.details.recipientName}</span></span>
          </ContainedListItem>
        ))}
      </ContainedList>
    </Part2>
  );
}

export function CustomersPlaceholder() {
  const { customerId } = useParams();
  return (
    <Part2 title="Customers" permission="orders.read" description="People and organizations who are billed."
      planned={['List with name, type, pricing group, open balance, orders and last activity', 'Detail with the pricing group assignment, invoicing requirements (purchase order reference), orders, unbilled jobs and payments']}>
      {customerId && <Tag type="outline">Customer detail opens here</Tag>}
      <Button as={Link} to="/sales/orders" kind="tertiary">Orders</Button>
    </Part2>
  );
}

export const PricingPlaceholder = () => (
  <Part2 title="Pricing" permission="pricing.read" description="Pricing groups, rules and what a job would cost."
    planned={['Moved here from Settings > Machines', 'Matrix of pricing groups and rules with inline editing and warnings for missing rules', 'Customer assignments and a calculator: what would a 2 h FDM job with 80 g PLA cost for a group']} />
);
