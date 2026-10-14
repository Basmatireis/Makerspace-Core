import { useState } from 'react';
import { Button, InlineNotification, Link as CarbonLink, OverflowMenu, OverflowMenuItem, Tab, TabList, TabPanel, TabPanels, Tabs, Tag, Tile } from '@carbon/react';
import { Add, ArrowLeft } from '@carbon/icons-react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { PageShell } from '../../../app/PageShell';
import { EmptyState } from '../../../app/PageState';
import { QueryBoundary } from '../components/QueryBoundary';
import { JobsTable } from '../components/JobsTable';
import { PrinterSetup } from '../components/PrinterSetup';
import { JobFormModal } from '../dialogs/JobFormModal';
import { MachineSetupWizard } from '../dialogs/MachineSetupWizard';
import { modelById } from '../mockData';
import { isPrinterType } from '../printerSetup';
import { AvailabilityTag, formatDateTime, formatHours, formatRelative, formatTime, machineActivity } from '../derived';
import { useNow, useSimulatedQuery, useStore } from '../store';
import type { ConnectorHost, DetectedPrinterState, Job, Machine, MachineType, Print, PrinterProfile } from '../types';
import '../styles/machines.scss';

type Data = { machine?: Machine; type?: MachineType; profile?: PrinterProfile; detected: DetectedPrinterState | null; hosts: ConnectorHost[]; jobs: Job[]; allJobs: Job[]; prints: Print[] };
const emptyData: Data = { detected: null, hosts: [], jobs: [], allJobs: [], prints: [] };
type TabKey = 'overview' | 'jobs' | 'printer';

const statusLabel = { active: 'Active', maintenance: 'Maintenance', retired: 'Retired' } as const;

export function MachineDetailPage() {
  const { machineId = '' } = useParams();
  const store = useStore();
  const [params, setParams] = useSearchParams();
  const [editOpen, setEditOpen] = useState(false);
  const [jobOpen, setJobOpen] = useState(false);
  const now = useNow();
  const query = useSimulatedQuery<Data>((d) => ({
    machine: d.machines.find((m) => m.id === machineId),
    type: d.machineTypes.find((t) => t.id === d.machines.find((m) => m.id === machineId)?.machineTypeId),
    profile: d.printerProfiles.find((p) => p.machineId === machineId),
    detected: d.detected[machineId] ?? null,
    hosts: d.connectorHosts,
    jobs: d.jobs.filter((j) => j.machineId === machineId).sort((a, b) => b.startsAt.localeCompare(a.startsAt)),
    allJobs: d.jobs,
    prints: d.prints,
  }), emptyData);
  const { machine, type, profile, detected, hosts, jobs, allJobs, prints } = query.data;

  const breadcrumbs = [{ label: 'Workshop', to: '/' }, { label: 'Machines', to: '/machines' }];
  if (query.status !== 'success') {
    return <PageShell title="Machine" breadcrumbs={breadcrumbs} width="wide"><QueryBoundary query={query} errorMessage="The machine could not be loaded."><></></QueryBoundary></PageShell>;
  }
  if (!machine) {
    return (
      <PageShell title="Machine not found" breadcrumbs={breadcrumbs} width="wide">
        <EmptyState title="Machine not found" description="It may have been removed, or the link is wrong." action={<Button as={Link} to="/machines" kind="tertiary" renderIcon={ArrowLeft}>Back to machines</Button>} />
      </PageShell>
    );
  }

  const activity = machineActivity(machine, prints, allJobs, now);
  const canManage = store.can('machines.manage');
  const showPrinterTab = Boolean(profile) || (canManage && isPrinterType(type));
  const tabs: TabKey[] = showPrinterTab ? ['overview', 'jobs', 'printer'] : ['overview', 'jobs'];
  const requested = params.get('tab') as TabKey | null;
  const tab: TabKey = requested && tabs.includes(requested) ? requested : 'overview';
  const selectTab = (index: number) => setParams((current) => {
    const next = new URLSearchParams(current);
    next.set('tab', tabs[index] ?? 'overview');
    return next;
  }, { replace: true });

  const accepting = machine.status !== 'retired';
  const canCreate = accepting && store.can('machine_jobs.create');
  const lastIngest = machine.lastIngestedAt ? formatRelative(machine.lastIngestedAt) : '—';

  const actions = (
    <>
      {canCreate && <Button renderIcon={Add} onClick={() => setJobOpen(true)}>New job</Button>}
      {canManage && (
        <OverflowMenu aria-label="More machine actions" flipped size="lg">
          <OverflowMenuItem itemText="Edit machine" onClick={() => setEditOpen(true)} />
        </OverflowMenu>
      )}
    </>
  );

  return (
    <PageShell
      title={machine.name} titleAdornment={<AvailabilityTag availability={activity.availability} />} description={type?.name ?? 'Unknown type'}
      breadcrumbs={[...breadcrumbs, { label: machine.name }]} actions={actions} width="wide"
    >
      <div className="mj-stack">
        {activity.connectorIssue && (
          <InlineNotification
            kind="warning" lowContrast hideCloseButton title={activity.connectorIssue}
            subtitle={`Automatic collection from ${hosts.find((host) => host.id === machine.connection?.connectorId)?.name ?? 'the connector'} may be delayed. Last ingest: ${lastIngest}.`}
          />
        )}
        <Tabs selectedIndex={tabs.indexOf(tab)} onChange={({ selectedIndex }) => selectTab(selectedIndex)}>
          <TabList aria-label="Machine sections" contained>
            <Tab>Overview</Tab>
            <Tab>Jobs</Tab>
            {showPrinterTab && <Tab>Printer setup</Tab>}
          </TabList>
          <TabPanels>
            <TabPanel>
              <div className="mj-tab-panel">
                <dl className="mj-facts">
                  <div><dt>Status</dt><dd>{statusLabel[machine.status]}</dd></div>
                  <div><dt>Type</dt><dd>{type?.name ?? '—'} {type && !type.active && <Tag size="sm" type="gray">Inactive type</Tag>}</dd></div>
                  <div><dt>Collection</dt><dd>{machine.automaticCollectionEnabled ? 'Automatic' : 'Manual'}</dd></div>
                  {machine.modelId && <div><dt>Model</dt><dd>{modelById(machine.modelId)?.label ?? '—'}</dd></div>}
                  {machine.connection?.serialNumber && <div><dt>Serial number</dt><dd>{machine.connection.serialNumber}</dd></div>}
                  <div><dt>Last ingest</dt><dd>{machine.lastIngestedAt ? formatDateTime(machine.lastIngestedAt) : '—'}</dd></div>
                </dl>
                <div className="mj-metrics" role="group" aria-label="Machine activity">
                  <Tile><div className="mj-metric__label">Jobs</div><div className="mj-metric__value">{machine.jobCount}</div></Tile>
                  <Tile><div className="mj-metric__label">Runtime</div><div className="mj-metric__value">{formatHours(machine.runtimeSeconds)}</div></Tile>
                  <Tile><div className="mj-metric__label">Failure rate</div><div className="mj-metric__value">{machine.failureRate}%</div></Tile>
                </div>
                {activity.current && (
                  <Tile>
                    <div className="mj-metric__label">In use now</div>
                    <p><CarbonLink as={Link} to={activity.current.href}>{activity.current.title}</CarbonLink></p>
                    <p className="mj-secondary">
                      {activity.current.kind === 'print' ? 'Reported by the printer' : 'Manual run'} · started {formatRelative(activity.current.startedAt)}
                      {activity.current.endsAt ? ` · ends ~${formatTime(activity.current.endsAt)}` : ''}
                    </p>
                  </Tile>
                )}
                <JobsTable jobs={jobs.slice(0, 5)} hideMachine size="sm" title="Recent jobs" emptyState={<EmptyState title="No jobs yet" description="Jobs created for this machine appear here." />} />
              </div>
            </TabPanel>
            <TabPanel>
              <div className="mj-tab-panel">
                <CarbonLink as={Link} to={`/jobs?machine=${machine.id}`}>Open in Jobs</CarbonLink>
                <JobsTable jobs={jobs} hideMachine emptyState={<EmptyState title="No jobs yet" description="Jobs created for this machine appear here." />} />
              </div>
            </TabPanel>
            {showPrinterTab && (
              <TabPanel><div className="mj-tab-panel"><PrinterSetup machine={machine} profile={profile} detected={detected} /></div></TabPanel>
            )}
          </TabPanels>
        </Tabs>
      </div>
      <MachineSetupWizard open={editOpen} onClose={() => setEditOpen(false)} machine={machine} initialStep="machine" />
      <JobFormModal open={jobOpen} onClose={() => setJobOpen(false)} mode="create" initialValues={{ machineId: machine.id }} />
    </PageShell>
  );
}
