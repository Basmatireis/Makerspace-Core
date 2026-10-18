import { useMemo, useState } from 'react';
import {
  Button, InlineNotification, Link as CarbonLink, Select, SelectItem, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TabList, TabPanel, TabPanels, Tabs, Tag, Tile, Toggle,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { jobName } from '../../derived';
import { useNow, useStore } from '../../store';
import { RequirePermission } from '../components/RequirePermission';
import { formatDate, formatDateTime, formatEur, formatSignedEur } from '../format';
import { customerKindLabel, methodLabel } from '../labels';
import { cashbookLines, customerSummaries, readyToBill, sum, type OrderView } from '../logic';
import { defaultGroupOf, effectiveGroup } from '../pricing';
import { OrderStatusTag, PaymentKindTag } from '../status';
import { useSalesData } from '../useSalesData';
import { useSalesMutation } from '../useSalesMutation';
import '../sales.scss';

const crumbs = [{ label: 'Sales & payments', to: '/sales' }, { label: 'Customers', to: '/sales/customers' }];

function CustomerDetail({ customerId, views }: { customerId: string; views: OrderView[] }) {
  const store = useStore();
  const navigate = useNavigate();
  const now = useNow();
  const { data } = useSalesData();
  const customer = store.customers.find((item) => item.id === customerId)!;
  const summary = useMemo(() => customerSummaries([customer], views, data.jobs, data.prints, now)[0], [customer, views, data.jobs, data.prints, now]);
  const group = useMemo(() => readyToBill(data.jobs, data.orders, data.prints, now).find((item) => item.customer.id === customerId), [data.jobs, data.orders, data.prints, now, customerId]);
  const lines = useMemo(() => cashbookLines(data.payments, data.allocations, data.orders, store.daySessions).filter((line) => line.order?.customer?.id === customerId), [data.payments, data.allocations, data.orders, store.daySessions, customerId]);
  const effective = effectiveGroup(store.pricing, customer.pricingGroup);
  const defaultGroup = defaultGroupOf(store.pricing);
  const [choice, setChoice] = useState<string | null>(null);
  const selected = choice ?? customer.pricingGroup ?? '';
  const canPricing = store.can('pricing.manage');
  const canOrganizations = store.can('organizations.manage');
  const assign = useSalesMutation(() => store.assignPricingGroup(customer.id, selected || null));
  const requirement = useSalesMutation((required: boolean) => store.setPurchaseOrderRequirement(customer.id, required));
  const orders = [...summary.orders].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const readyRows = group?.ready ?? [];
  const createOrder = () => {
    try {
      const party = { kind: customer.kind, id: customer.id, displayName: customer.displayName, pricingGroup: effective.name };
      const id = store.createDraftFromJobs(party, readyRows.map((row) => row.job.id)).orderId;
      store.notify({ kind: 'success', title: 'Draft order created', subtitle: `${readyRows.length} ${readyRows.length === 1 ? 'job' : 'jobs'} added. Review and finalize it.` });
      navigate(`/sales/orders/${id}`);
    } catch (error) { store.notify({ kind: 'error', title: 'Could not create the order', subtitle: error instanceof Error ? error.message : undefined }); }
  };
  const unbilledTotal = group?.total ?? 0;

  return (
    <PageShell
      title={customer.displayName} titleAdornment={<Tag type={customer.kind === 'organization' ? 'blue' : 'cool-gray'} size="md">{customerKindLabel(customer.kind)}</Tag>} width="wide" breadcrumbs={crumbs}
      description={`Pricing group ${effective.name}${customer.pricingGroup === null ? ' (the default)' : ''}`}
      actions={store.can('orders.write') ? <Button kind="tertiary" renderIcon={Add} disabled={readyRows.length === 0} onClick={createOrder}>{readyRows.length ? `Bill ${readyRows.length} ${readyRows.length === 1 ? 'job' : 'jobs'}` : 'No job to bill'}</Button> : undefined}
    >
      <div className="mj-stack">
        <section className="sales-tiles" aria-label="Customer figures">
          <Tile className="sales-tile"><span className="sales-tile__label">Open balance</span><span className={`sales-tile__value${summary.openBalance > 0 ? ' sales-num--due' : ''}`}>{formatEur(summary.openBalance)}</span><span className="mj-secondary">Outstanding on finalized orders</span></Tile>
          <Tile className="sales-tile"><span className="sales-tile__label">Orders</span><span className="sales-tile__value">{orders.filter((order) => order.status !== 'draft' && order.status !== 'cancelled').length}</span><span className="mj-secondary">{orders.filter((order) => order.status === 'draft').length} drafts</span></Tile>
          <Tile className="sales-tile"><span className="sales-tile__label">Unbilled jobs</span><span className="sales-tile__value">{group?.rows.length ?? 0}</span><span className="mj-secondary">{readyRows.length ? `${formatEur(unbilledTotal)} ready to bill` : 'Nothing ready to bill'}</span></Tile>
          <Tile className="sales-tile"><span className="sales-tile__label">Last activity</span><span className="sales-tile__value sales-tile__value--text">{summary.lastActivity ? formatDate(summary.lastActivity) : '—'}</span><span className="mj-secondary">{summary.lastActivity ? formatDateTime(summary.lastActivity) : 'No orders or jobs yet'}</span></Tile>
        </section>

        <div className="sales-two-cols">
          <Tile>
            <h2 className="mj-section-title">Pricing group</h2>
            <div className="mj-stack">
              <p className="mj-secondary">New jobs of this customer are priced with this group. Jobs that already have a price keep it.</p>
              <Select id="customer-group" labelText="Pricing group" value={selected} disabled={!canPricing || assign.pending} onChange={(event) => setChoice(event.target.value)}>
                <SelectItem value="" text={`Follow the default group (${defaultGroup.name})`} />
                {store.pricing.groups.filter((item) => item.active || item.name === customer.pricingGroup).map((item) => <SelectItem key={item.id} value={item.name} text={`${item.name}${item.active ? '' : ' (inactive)'}`} />)}
              </Select>
              {assign.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={assign.error} />}
              <div className="mj-inline">
                <Button kind="primary" size="md" disabled={!canPricing || assign.pending || selected === (customer.pricingGroup ?? '')} onClick={() => { void assign.mutate().then((result) => { if (result.ok) { setChoice(null); store.notify({ kind: 'success', title: 'Pricing group saved', subtitle: `${customer.displayName} is priced with ${selected || defaultGroup.name} from now on.` }); } }); }}>{assign.pending ? 'Saving…' : 'Save'}</Button>
                <Button kind="ghost" as={Link} to="/sales/pricing?tab=assignments" size="md">All assignments</Button>
              </div>
              {!canPricing && <p className="mj-secondary">Changing the group needs the permission to manage pricing.</p>}
            </div>
          </Tile>
          <Tile>
            <h2 className="mj-section-title">Invoicing requirements</h2>
            {customer.kind === 'organization' ? (
              <div className="mj-stack">
                <Toggle id="customer-po" labelText="Purchase order reference" labelA="Not required" labelB="Required on every invoice" toggled={customer.requiresPurchaseOrder} disabled={!canOrganizations || requirement.pending}
                  onToggle={(checked) => { void requirement.mutate(checked).then((result) => { if (result.ok) store.notify({ kind: 'success', title: checked ? 'Purchase order reference required' : 'Purchase order reference no longer required' }); }); }} />
                <p className="mj-secondary">This applies to wiRef requests that are marked ready from now on. Requests that are already ready keep what they captured.</p>
                {requirement.error && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={requirement.error} />}
                {!canOrganizations && <p className="mj-secondary">Changing it needs the permission to manage organizations.</p>}
              </div>
            ) : <p className="mj-secondary">People have no invoicing requirements. Organizations can require a purchase order reference on their invoices.</p>}
          </Tile>
        </div>

        <Tabs>
          <TabList aria-label="Customer sections" contained>
            <Tab>Orders</Tab><Tab>Unbilled jobs{(group?.rows.length ?? 0) > 0 && <Tag type="blue" size="sm" className="sales-tab-count">{group!.rows.length}</Tag>}</Tab><Tab>Payments</Tab>
          </TabList>
          <TabPanels>
            <TabPanel className="sales-tab-panel">
              <TableContainer>
                <Table aria-label="Orders of this customer">
                  <TableHead><TableRow><TableHeader>Order</TableHeader><TableHeader>Status</TableHeader><TableHeader className="sales-num">Total</TableHeader><TableHeader className="sales-num">Outstanding</TableHeader><TableHeader className="mj-hide-narrow">Updated</TableHeader></TableRow></TableHead>
                  <TableBody>
                    {orders.map((order) => (
                      <TableRow key={order.id} className="mj-table-row" onClick={() => navigate(`/sales/orders/${order.id}`)}>
                        <TableCell><CarbonLink as={Link} to={`/sales/orders/${order.id}`} onClick={(event: React.MouseEvent) => event.stopPropagation()}>{order.reference}</CarbonLink></TableCell>
                        <TableCell><OrderStatusTag order={order} /></TableCell>
                        <TableCell className="sales-num">{formatEur(order.total)}</TableCell>
                        <TableCell className={`sales-num${order.outstanding > 0 ? ' sales-num--due' : ''}`}>{order.status === 'finalized' ? formatEur(order.outstanding) : '—'}</TableCell>
                        <TableCell className="mj-hide-narrow">{formatDateTime(order.updatedAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {orders.length === 0 && <EmptyState title="No orders yet" description="Orders of this customer appear here." />}
              </TableContainer>
            </TabPanel>
            <TabPanel className="sales-tab-panel">
              <TableContainer title="Finished jobs that are on no order" description="Add them to an order to charge them.">
                <Table aria-label="Unbilled jobs">
                  <TableHead><TableRow><TableHeader>Job</TableHeader><TableHeader className="mj-hide-narrow">Finished</TableHeader><TableHeader className="sales-num">Price</TableHeader><TableHeader>Status</TableHeader></TableRow></TableHead>
                  <TableBody>
                    {(group?.rows ?? []).map((row) => (
                      <TableRow key={row.job.id}>
                        <TableCell><CarbonLink as={Link} to={`/jobs/${row.job.id}`}>{row.job.displayId}</CarbonLink> <span className="mj-secondary">{jobName(row.job, data.prints.find((print) => print.id === row.job.printId))}</span></TableCell>
                        <TableCell className="mj-hide-narrow">{formatDateTime(row.job.endsAt)}</TableCell>
                        <TableCell className="sales-num">{formatEur(row.price)}</TableCell>
                        <TableCell>{row.reason ? <span className="mj-secondary">{row.reason}</span> : <Tag type="green" size="sm">Ready to bill</Tag>}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {(group?.rows.length ?? 0) === 0 && <EmptyState title="No unbilled jobs" description="Every finished job of this customer is on an order." />}
              </TableContainer>
            </TabPanel>
            <TabPanel className="sales-tab-panel">
              <TableContainer>
                <Table aria-label="Payments of this customer">
                  <TableHead><TableRow><TableHeader>Time</TableHeader><TableHeader>Payment</TableHeader><TableHeader className="mj-hide-narrow">Order</TableHeader><TableHeader className="mj-hide-narrow">Method</TableHeader><TableHeader className="sales-num">Amount</TableHeader></TableRow></TableHead>
                  <TableBody>
                    {lines.map((line) => (
                      <TableRow key={line.payment.id} className="mj-table-row" onClick={() => navigate(`/sales/payments/${line.payment.id}`)}>
                        <TableCell>{formatDateTime(line.payment.occurredAt)}</TableCell>
                        <TableCell><div className="mj-cell-stack"><CarbonLink as={Link} to={`/sales/payments/${line.payment.id}`} onClick={(event: React.MouseEvent) => event.stopPropagation()}>{line.payment.reference}</CarbonLink><span><PaymentKindTag payment={line.payment} /></span></div></TableCell>
                        <TableCell className="mj-hide-narrow">{line.order?.reference}</TableCell>
                        <TableCell className="mj-hide-narrow">{methodLabel(line.payment.method)}</TableCell>
                        <TableCell className={`sales-num${line.signed < 0 ? ' sales-num--due' : ''}`}>{line.payment.entryKind === 'reversal' ? formatSignedEur(line.signed) : formatEur(line.signed)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {lines.length === 0 && <EmptyState title="No payments yet" description="Payments for this customer’s orders appear here." />}
              </TableContainer>
              {lines.length > 0 && <p className="mj-secondary sales-table-note">Net received so far: {formatEur(sum(lines.map((line) => line.signed)))}</p>}
            </TabPanel>
          </TabPanels>
        </Tabs>
      </div>
    </PageShell>
  );
}

export function CustomerDetailPage() {
  const { customerId = '' } = useParams();
  const store = useStore();
  const { query, views } = useSalesData();
  const found = store.customers.some((item) => item.id === customerId);
  return (
    <RequirePermission permission="orders.read" title="Customer" crumbs={crumbs}>
      {query.status === 'success' && found ? <CustomerDetail customerId={customerId} views={views} /> : (
        <PageShell title={query.status === 'success' ? 'Customer not found' : 'Customer'} breadcrumbs={crumbs} width="wide">
          <QueryBoundary query={query} errorMessage="The customer could not be loaded.">
            <EmptyState title="This customer does not exist" description="The link may be incorrect." action={<Button kind="tertiary" as={Link} to="/sales/customers">Back to customers</Button>} />
          </QueryBoundary>
        </PageShell>
      )}
    </RequirePermission>
  );
}
