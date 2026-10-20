import { useState, type ReactNode } from 'react';
import { Button, InlineNotification, Link as CarbonLink, OverflowMenu, OverflowMenuItem, Tab, TabList, TabPanel, TabPanels, Tabs, Tag, Tile } from '@carbon/react';
import { Add, ArrowLeft } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { MachineAvailability, MachineStatus, PrinterProfile } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { JobsTable } from './components/JobsTable';
import { PrinterSetup } from './components/PrinterSetup';
import { DeleteMachineModal } from './dialogs/DeleteMachineModal';
import { JobFormModal } from './dialogs/JobFormModal';
import { MachineSetupWizard } from './dialogs/MachineSetupWizard';
import { usePrinterConnection } from './connectorQueries';
import { modelById } from './printerSetup';
import { machineActivityQuery, machineQuery, printerQuery, workItemsQuery } from './queries';
import { formatDateTime, formatHours, formatQuantity, formatRelative, formatTime } from './shared/format';
import { machineLogbookPaths } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { AvailabilityTag, connectorIssue, currentItemName } from './shared/status';
import { useCan } from './shared/useCan';
import { useNow } from './shared/useNow';
import './styles/machines.scss';

type TabKey = 'overview' | 'jobs' | 'printer';

const statusLabel: Record<MachineStatus, string> = { active: 'Active', maintenance: 'Maintenance', retired: 'Retired' };
const tabLabels: Record<TabKey, string> = { overview: 'Overview', jobs: 'Jobs', printer: 'Printer setup' };
const JOBS_LIMIT = 100;
// Runs reported by connectors appear without a reload.
const JOBS_REFRESH_MS = 10_000;
const PRINTER_REFRESH_MS = 5000;

export function MachineDetailPage() {
  const { machineId = '' } = useParams();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const [editOpen, setEditOpen] = useState(false);
  const [jobOpen, setJobOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  useNow();
  const canManage = can('machines.manage');
  const canReadJobs = can('machine_jobs.read');
  const requested = params.get('tab') as TabKey | null;
  const printerSelected = requested === 'printer';
  const machineResult = useQuery(machineQuery(machineId));
  const activityResult = useQuery(machineActivityQuery());
  const printer = useQuery({ ...printerQuery(machineId), retry: false, refetchInterval: printerSelected ? PRINTER_REFRESH_MS : false });
  const jobsResult = useQuery({ ...workItemsQuery({ machineId: [machineId], sort: 'startedAt', direction: 'desc', pageSize: JOBS_LIMIT }), enabled: canReadJobs, refetchInterval: JOBS_REFRESH_MS });

  const machine = machineResult.data;
  const profile: PrinterProfile | undefined = printer.data;
  const profileAbsent = printer.isError && printer.error instanceof ApiError && printer.error.status === 404;
  const showPrinterTab = Boolean(profile) || (canManage && machine?.machineType.process === 'fdm_printing');
  const canReadConnectors = can('printer_connectors.read');
  const { connection } = usePrinterConnection(machineId, canReadConnectors && showPrinterTab, printerSelected ? PRINTER_REFRESH_MS : undefined);
  const tabs: TabKey[] = ['overview', ...(canReadJobs ? ['jobs' as const] : []), ...(showPrinterTab ? ['printer' as const] : [])];
  const tab: TabKey = requested && tabs.includes(requested) ? requested : 'overview';
  const selectTab = (index: number) => setParams((current) => {
    const next = new URLSearchParams(current);
    next.set('tab', tabs[index] ?? 'overview');
    return next;
  }, { replace: true });

  const breadcrumbs = [{ label: 'Workshop', to: machineLogbookPaths.overview() }, { label: 'Machines', to: machineLogbookPaths.machines() }];
  if (machineResult.isError && machineResult.error instanceof ApiError && machineResult.error.status === 404) {
    return (
      <PageShell title="Machine not found" breadcrumbs={breadcrumbs} width="wide">
        <EmptyState title="Machine not found" description="It may have been removed, or the link is wrong." action={<Button as={Link} to={machineLogbookPaths.machines()} kind="tertiary" renderIcon={ArrowLeft}>Back to machines</Button>} />
      </PageShell>
    );
  }
  if (!machine || activityResult.isPending || printer.isPending) {
    // Tabs are only built once the printer profile is known, so a printer tab in the URL is selected from the start.
    const loading = { status: machineResult.isError ? 'error' : 'pending', data: undefined, refetch: machineResult.refetch } as const;
    return (
      <PageShell title="Machine" breadcrumbs={breadcrumbs} width="wide">
        <QueryBoundary query={loading} errorMessage="The machine could not be loaded."><></></QueryBoundary>
      </PageShell>
    );
  }

  const entry = activityResult.data?.items.find((item) => item.machineId === machineId);
  const availability: MachineAvailability = entry?.availability ?? (machine.status === 'active' ? 'available' : machine.status);
  const current = entry?.current ?? null;
  const issue = availability === 'retired' ? null : connectorIssue(entry?.connector ?? undefined);
  const jobs = jobsResult.data?.items ?? [];
  const accepting = machine.status !== 'retired';
  const canCreate = accepting && can('machine_jobs.create');
  const lastIngest = machine.lastIngestedAt ? formatRelative(machine.lastIngestedAt) : '—';
  const jobsLink = machineLogbookPaths.jobs({ machine: machine.id });
  const noJobs = <EmptyState title="No jobs yet" description="Jobs created for this machine appear here." />;
  const jobsBoundary = (render: () => ReactNode) => (
    <QueryBoundary query={jobsResult} errorMessage="The jobs of this machine could not be loaded.">{render}</QueryBoundary>
  );

  const panels: Record<TabKey, ReactNode> = {
    overview: (
      <div className="mj-tab-panel">
        <dl className="mj-facts">
          <div><dt>Status</dt><dd>{statusLabel[machine.status]}</dd></div>
          <div><dt>Type</dt><dd>{machine.machineType.name} {!machine.machineType.active && <Tag size="sm" type="gray">Inactive type</Tag>}</dd></div>
          <div><dt>Collection</dt><dd>{machine.automaticCollectionEnabled ? 'Automatic' : 'Manual'}</dd></div>
          {modelById(profile?.model)?.label && <div><dt>Model</dt><dd>{modelById(profile?.model)?.label}</dd></div>}
          {typeof connection?.assignment.settings.serialNumber === 'string' && <div><dt>Serial number</dt><dd>{connection.assignment.settings.serialNumber}</dd></div>}
          <div><dt>External identifier</dt><dd>{machine.externalIdentifier ?? '—'}</dd></div>
          <div><dt>Last ingest</dt><dd>{machine.lastIngestedAt ? formatDateTime(machine.lastIngestedAt) : '—'}</dd></div>
        </dl>
        <div className="mj-metrics" role="group" aria-label="Machine activity">
          <Tile><div className="mj-metric__label">Jobs</div><div className="mj-metric__value">{machine.jobCount}</div></Tile>
          <Tile><div className="mj-metric__label">Runtime</div><div className="mj-metric__value">{formatHours(machine.runtimeSeconds)}</div></Tile>
          <Tile><div className="mj-metric__label">Failure rate</div><div className="mj-metric__value">{formatQuantity(machine.failureRate, 1)}%</div></Tile>
        </div>
        {current && (
          <Tile>
            <div className="mj-metric__label">In use now</div>
            <p>
              <CarbonLink as={Link} to={current.kind === 'run' ? machineLogbookPaths.run(current.id) : machineLogbookPaths.job(current.id)}>
                {currentItemName(current)}
              </CarbonLink>
            </p>
            <p className="mj-secondary">
              {current.kind === 'run' ? 'Unassigned run' : 'Job'} · started {formatRelative(current.startedAt)}
              {current.endsAt ? ` · ends ~${formatTime(current.endsAt)}` : ''}
            </p>
          </Tile>
        )}
        {canReadJobs && jobsBoundary(() => <JobsTable jobs={jobs.slice(0, 5)} hideMachine size="sm" title="Recent jobs" emptyState={noJobs} />)}
      </div>
    ),
    jobs: (
      <div className="mj-tab-panel">
        <CarbonLink as={Link} to={jobsLink}>Open in Jobs</CarbonLink>
        {jobsBoundary(() => (
          <>
            <JobsTable jobs={jobs} hideMachine emptyState={noJobs} />
            {(jobsResult.data?.total ?? 0) > jobs.length && <p className="mj-secondary">Showing the latest {jobs.length} of {jobsResult.data?.total} jobs. Open in Jobs to see all of them.</p>}
          </>
        ))}
      </div>
    ),
    printer: (
      <div className="mj-tab-panel">
        <QueryBoundary
          query={{ status: profileAbsent ? 'success' : printer.status, data: profile, refetch: printer.refetch }}
          errorMessage="Printer setup could not be loaded."
        >
          <PrinterSetup machine={machine} profile={profile} connection={connection} active={tab === 'printer'} />
        </QueryBoundary>
      </div>
    ),
  };

  const actions = (
    <>
      {canCreate && <Button renderIcon={Add} onClick={() => setJobOpen(true)}>New job</Button>}
      {canManage && (
        <OverflowMenu aria-label="More machine actions" iconDescription="More machine actions" flipped size="lg">
          <OverflowMenuItem itemText="Edit machine" onClick={() => setEditOpen(true)} />
          <OverflowMenuItem itemText="Delete machine" isDelete hasDivider onClick={() => setDeleteOpen(true)} />
        </OverflowMenu>
      )}
    </>
  );

  return (
    <PageShell
      title={machine.name} titleAdornment={<AvailabilityTag availability={availability} />} description={machine.machineType.name}
      breadcrumbs={[...breadcrumbs, { label: machine.name }]} actions={actions} width="wide"
    >
      <div className="mj-stack">
        {issue && (
          <InlineNotification
            kind="warning" lowContrast hideCloseButton title={issue}
            subtitle={`Automatic collection from the connector may be delayed. Last ingest: ${lastIngest}.`}
          />
        )}
        <Tabs selectedIndex={tabs.indexOf(tab)} onChange={({ selectedIndex }) => selectTab(selectedIndex)}>
          <TabList aria-label="Machine sections" contained>
            {tabs.map((key) => <Tab key={key}>{tabLabels[key]}</Tab>)}
          </TabList>
          <TabPanels>
            {tabs.map((key) => <TabPanel key={key}>{panels[key]}</TabPanel>)}
          </TabPanels>
        </Tabs>
      </div>
      {canManage && editOpen && <MachineSetupWizard open onClose={() => setEditOpen(false)} machine={machine} profile={profile} connection={connection} initialStep="machine" />}
      {canManage && <DeleteMachineModal machine={machine} open={deleteOpen} onClose={() => setDeleteOpen(false)} />}
      {canCreate && <JobFormModal open={jobOpen} onClose={() => setJobOpen(false)} mode="create" initialValues={{ machineId: machine.id }} />}
    </PageShell>
  );
}
