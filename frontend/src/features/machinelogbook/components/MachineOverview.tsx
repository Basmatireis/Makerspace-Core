import { Button, InlineNotification, Tag } from '@carbon/react';
import { ArrowRight, Edit } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';
import type { PrinterProfile, WorkItem, WorkItemPage } from '../../../api/generated/models';
import { StackCard } from '../../../app/components/CardList';
import { FactTiles } from '../../../app/components/Facts';
import { EmptyState } from '../../../app/PageState';
import { liveStatusQuery, type PrinterConnection } from '../connectorQueries';
import { machineMaterialTypesQuery } from '../machinesQueries';
import { isFdm } from '../processConfig';
import { modelById } from '../printerSetup';
import { formatHours, formatQuantity, formatRelative, formatTime } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { QueryBoundary } from '../shared/QueryBoundary';
import { availabilityLabel } from '../shared/status';
import { useCan } from '../shared/useCan';
import { MachineJobsTable } from './MachineJobsTable';
import { MachinePreview } from './MachinePanel';
import { SummaryList } from './SummaryList';
import {
  ConnectorStateTag,
  connectorStateLabel,
  currentStatusText,
  idleText,
  mountedSpoolLines,
  type MachineRow,
} from './machineParts';

const LIVE_REFRESH_MS = 5000;
const WEEK_MS = 7 * 24 * 3600 * 1000;
const RECENT_JOBS = 5;

const statusLabel = { active: 'Active', maintenance: 'Maintenance', retired: 'Retired' } as const;

function LiveCard({ row, profile }: { row: MachineRow; profile: PrinterProfile | undefined }) {
  const printer = isFdm(row.machine.process);
  const live = useQuery({
    ...liveStatusQuery(row.machine.id),
    enabled: printer && row.connectorState !== 'none',
    refetchInterval: LIVE_REFRESH_MS,
  });
  const status = live.data?.status;
  const nozzles = (status?.temperatures.extruders ?? [])
    .map((extruder) => extruder.currentC)
    .filter((value): value is number => value != null)
    .map((value) => `${Math.round(value)} °C`);
  const spools = mountedSpoolLines(profile);
  return (
    <StackCard title={row.current ? 'Now' : 'Live'} className="mj-live-card">
      <MachinePreview row={row} />
      {status?.job?.progressPercent != null && row.current && (
        <p className="mj-secondary">
          {status.job.progressPercent} %
          {status.job.layer != null && status.job.totalLayers
            ? ` · layer ${status.job.layer}/${status.job.totalLayers}`
            : ''}
          {row.current.endsAt ? ` · ends ~${formatTime(row.current.endsAt)}` : ''}
        </p>
      )}
      {printer && (status || profile) && (
        <SummaryList
          label="Printer status"
          items={[
            status ? { label: 'Printer', value: status.state } : null,
            nozzles.length > 0 ? { label: 'Nozzle', value: nozzles.join(' / ') } : null,
            status?.temperatures.bedC != null
              ? { label: 'Bed', value: `${Math.round(status.temperatures.bedC)} °C` }
              : null,
            status?.temperatures.chamberC != null
              ? { label: 'Chamber', value: `${Math.round(status.temperatures.chamberC)} °C` }
              : null,
            profile
              ? {
                  label: 'Spools',
                  value: spools.length ? (
                    <span className="mj-lines">
                      {spools.map((line) => (
                        <span key={line.id}>
                          <span className="mj-secondary">{line.where}</span> {line.spool}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="mj-secondary">None mounted</span>
                  ),
                }
              : null,
          ]}
        />
      )}
    </StackCard>
  );
}

function MaterialCategories({ processId }: { processId: string }) {
  const can = useCan();
  const types = useQuery({ ...machineMaterialTypesQuery(), enabled: can('inventory.read') });
  if (!can('inventory.read')) return null;
  return (
    <StackCard
      title="Material categories"
      action={
        can('inventory.manage') ? (
          <Button kind="ghost" size="sm" renderIcon={Edit} as={Link} to={machineLogbookPaths.inventory('types')}>
            Edit
          </Button>
        ) : undefined
      }
    >
      <QueryBoundary query={types} errorMessage="The material categories could not be loaded.">
        {(list) => {
          const fitting = list.items.filter((type) => type.active && type.processIds.includes(processId));
          return fitting.length ? (
            <div className="mj-tags">
              {fitting.map((type) => (
                <Tag key={type.id} type="blue" size="md">
                  {type.name}
                </Tag>
              ))}
            </div>
          ) : (
            <p className="mj-secondary">None</p>
          );
        }}
      </QueryBoundary>
      <p className="mj-secondary">
        Runs on this machine can consume these categories; rates come from the pricing groups.
      </p>
    </StackCard>
  );
}

/** Overview of a machine: what needs attention, fact tiles, recent jobs, material categories, live status and facts. */
export function MachineOverview({
  row,
  profile,
  connection,
  jobs,
  jobsQuery,
  onShowJobs,
}: {
  row: MachineRow;
  profile: PrinterProfile | undefined;
  connection: PrinterConnection | undefined;
  jobs: WorkItem[];
  /** The machine's jobs query; null when the viewer cannot read jobs. */
  jobsQuery: Pick<UseQueryResult<WorkItemPage>, 'status' | 'data' | 'refetch'> | null;
  onShowJobs: () => void;
}) {
  const { machine } = row;
  const model = modelById(profile?.model)?.label;
  const serial = connection?.assignment.settings.serialNumber;
  const weekAgo = Date.now() - WEEK_MS;
  const thisWeek = jobs.filter((job) => new Date(job.startedAt).getTime() >= weekAgo).length;
  return (
    <div className="mj-stack mj-stack--loose">
      {machine.attention.length > 0 && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Needs attention"
          subtitle={machine.attention.map((item) => item.message).join(' · ')}
        />
      )}
      <FactTiles
        label="Machine facts"
        items={[
          {
            label: 'Status',
            value: availabilityLabel(row.availability),
            helper: row.current ? currentStatusText(row.current) : idleText(row),
          },
          {
            label: 'Jobs',
            value: machine.jobCount,
            helper: jobsQuery ? `${thisWeek} this week` : undefined,
          },
          { label: 'Runtime', value: formatHours(machine.runtimeSeconds), helper: 'All runs' },
          {
            label: 'Failure rate',
            value: `${formatQuantity(machine.failureRate, 1)} %`,
            helper: 'Of runs with outcome',
          },
          {
            label: 'Collection',
            value: machine.automaticCollectionEnabled ? 'Automatic' : 'Manual',
            helper:
              row.connectorState === 'none'
                ? 'Runs entered by hand'
                : `${connectorStateLabel(row.connector)}${
                    row.connector?.lastHeartbeatAt
                      ? ` · heartbeat ${formatRelative(row.connector.lastHeartbeatAt)}`
                      : ''
                  }`,
          },
          { label: 'Process', value: machine.process.name, helper: model ?? '—' },
        ]}
      />
      <div className="mj-two-col mj-two-col--side">
        <div className="mj-stack mj-stack--loose">
          {jobsQuery && (
            <StackCard
              title="Jobs"
              count={machine.jobCount}
              action={
                <Button kind="ghost" size="sm" renderIcon={ArrowRight} onClick={onShowJobs}>
                  All jobs
                </Button>
              }
            >
              <QueryBoundary query={jobsQuery} errorMessage="The jobs of this machine could not be loaded.">
                {jobs.length ? (
                  <MachineJobsTable jobs={jobs.slice(0, RECENT_JOBS)} label="Recent jobs" />
                ) : (
                  <EmptyState title="No jobs yet" description="Jobs created for this machine appear here." />
                )}
              </QueryBoundary>
            </StackCard>
          )}
          <MaterialCategories processId={machine.process.id} />
        </div>
        <div className="mj-stack mj-stack--loose">
          <LiveCard row={row} profile={profile} />
          <StackCard title="Facts">
            <SummaryList
              label="Machine details"
              items={[
                { label: 'Process', value: machine.process.name },
                model ? { label: 'Model', value: model } : null,
                typeof serial === 'string' && serial ? { label: 'Serial number', value: serial, mono: true } : null,
                machine.externalIdentifier
                  ? { label: 'External ID', value: machine.externalIdentifier, mono: true }
                  : null,
                {
                  label: 'Collection',
                  value: (
                    <>
                      {machine.automaticCollectionEnabled ? 'Automatic' : 'Manual'}{' '}
                      <span className="mj-secondary">
                        ·{' '}
                        {machine.automaticCollectionEnabled
                          ? 'runs come from the connector'
                          : 'runs are entered by hand'}
                      </span>
                    </>
                  ),
                },
                row.connectorState !== 'none'
                  ? { label: 'Connector', value: <ConnectorStateTag connector={row.connector} /> }
                  : null,
                { label: 'Status', value: statusLabel[machine.status] },
                machine.process.measures.length
                  ? { label: 'Measures', value: machine.process.measures.map((measure) => measure.label).join(', ') }
                  : null,
                machine.lastIngestedAt ? { label: 'Last data', value: formatRelative(machine.lastIngestedAt) } : null,
              ]}
            />
          </StackCard>
        </div>
      </div>
    </div>
  );
}
