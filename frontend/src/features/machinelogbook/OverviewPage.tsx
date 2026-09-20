import { Button, Column, Grid, Link as CarbonLink, Stack, Tile } from '@carbon/react';
import { Add, InventoryManagement } from '@carbon/icons-react';
import { SimpleBarChart } from '@carbon/charts-react';
import { ScaleTypes } from '@carbon/charts';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { PermissionId, hasPermission } from '../auth/permissions';
import { useCurrentUser } from '../auth/auth';
import { EmptyState, OutcomeTag, StockTag } from './components';
import { formatDateTime, formatDecimal } from './formatting';
import { overviewQuery } from './queries';

export function MachineLogbookOverviewPage() {
  const currentUser = useCurrentUser();
  const query = useQuery(overviewQuery());
  if (query.isPending) return <FullPageLoading label="Loading machine logbook" />;
  if (query.isError) return <ErrorState message="The overview could not be loaded." onRetry={() => query.refetch()} />;
  const data = query.data;
  const chartData = data.activity.map((point) => ({ group: 'Jobs', key: point.date, value: point.count }));
  const chartOptions = { title: 'Job activity — last 7 days', axes: { left: { mapsTo: 'value', scaleType: ScaleTypes.LINEAR }, bottom: { mapsTo: 'key', scaleType: ScaleTypes.LABELS } }, height: '280px', legend: { enabled: false }, toolbar: { enabled: false }, accessibility: { svgAriaLabel: 'Bar chart of machine jobs per day' } };

  return <Stack gap={7} className="machine-logbook-page">
    <PageHeader title="Machine logbook" description="Operational overview of machine use, billing, and stock." actions={<>
      {hasPermission(currentUser, PermissionId.inventorymanage) && <Button as={Link} to="/machine-logbook/inventory" kind="secondary" renderIcon={InventoryManagement}>Add material</Button>}
      {hasPermission(currentUser, PermissionId.machine_jobscreate) && <Button as={Link} to="/machine-logbook/jobs?new=1" renderIcon={Add}>New job</Button>}
    </>} />
    {data.needsReview > 0 && <Tile className="review-callout"><div><strong>{data.needsReview} machine {data.needsReview === 1 ? 'job requires' : 'jobs require'} review</strong><p>Automatically detected jobs await customer and operator assignment.</p></div><CarbonLink as={Link} to="/machine-logbook/review">Review now →</CarbonLink></Tile>}
    <div className="metric-grid">
      <Tile><span>Jobs today</span><strong>{data.jobsToday}</strong><small>{data.jobsThisWeek} this week</small></Tile>
      <Tile><span>Unbilled jobs</span><strong>{data.unbilledJobs}</strong><small>€ {formatDecimal(data.unbilledAmount)} open</small></Tile>
      <Tile><span>Needs review</span><strong>{data.needsReview}</strong><small>auto-detected</small></Tile>
      <Tile><span>Failed / partial</span><strong>{data.failedOrPartialThisWeek}</strong><small>this week</small></Tile>
      <Tile><span>Low stock items</span><strong>{data.lowStockItems}</strong><small>materials</small></Tile>
    </div>
    <Grid condensed className="machine-logbook-grid">
      <Column sm={4} md={8} lg={11}><Tile className="chart-tile"><SimpleBarChart data={chartData} options={chartOptions} /><table className="accessible-data-table"><caption>Jobs by day</caption><thead><tr><th>Date</th><th>Jobs</th></tr></thead><tbody>{data.activity.map((point) => <tr key={point.date}><td>{point.date}</td><td>{point.count}</td></tr>)}</tbody></table></Tile></Column>
      <Column sm={4} md={8} lg={5}><Stack gap={5}>
        <Tile><h2>Low stock</h2>{data.lowStockMaterials.length === 0 ? <EmptyState title="Stock is healthy" description="No low-stock materials." /> : <ul className="summary-list">{data.lowStockMaterials.map((material) => <li key={material.id}><Link to={`/machine-logbook/inventory/${material.id}`}><span><strong>{material.name}</strong><small>{formatDecimal(material.quantity)} {material.unit}</small></span><StockTag state={material.stockState} /></Link></li>)}</ul>}</Tile>
        <Tile><h2>Recent jobs</h2>{data.recentJobs.length === 0 ? <EmptyState title="No jobs yet" description="Confirmed and detected jobs appear here." /> : <ul className="summary-list">{data.recentJobs.map((job) => <li key={job.id}><Link to={`/machine-logbook/jobs/${job.id}`}><span><strong>{job.machine.name}</strong><small>{formatDateTime(job.startsAt)} · {job.usages.map((u) => `${formatDecimal(u.quantity)} ${u.unit} ${u.materialName}`).join(', ') || 'No material usage'}</small></span><OutcomeTag outcome={job.outcome} /></Link></li>)}</ul>}</Tile>
      </Stack></Column>
    </Grid>
  </Stack>;
}
