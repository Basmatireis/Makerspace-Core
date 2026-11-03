import { Button, IconButton, Link as CarbonLink } from '@carbon/react';
import { ArrowRight, Close, NoImage, PlayFilledAlt, WarningAlt } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { WorkItem } from '../../../api/generated/models';
import { AttentionFlag } from '../../../app/components/AttentionFlag';
import { DetailPanel, DetailPanelHead, DetailPanelSection } from '../../../app/components/DetailPanel';
import { liveStatusQuery } from '../connectorQueries';
import { isFdm } from '../processConfig';
import { modelById } from '../printerSetup';
import { jobRecordingsQuery, printerQuery, recordingQuery, workItemsQuery } from '../queries';
import { thumbnailsOf } from '../recording/thumbnails';
import { formatHours, formatQuantity, formatRelative } from '../shared/format';
import { machineLogbookPaths } from '../shared/paths';
import { AvailabilityTag, JobRowStatusTag, currentItemName, workItemName } from '../shared/status';
import { useCan } from '../shared/useCan';
import { SummaryList, type SummaryItem } from './SummaryList';
import {
  ConnectorStateTag,
  connectorStateLabel,
  currentStatusText,
  idleText,
  mountedSpoolLines,
  temperaturesText,
  type MachineRow,
} from './machineParts';

const LIVE_REFRESH_MS = 10_000;

/** Preview of what a machine is doing: the plate image of the running print, or what the machine is up to. */
export function MachinePreview({ row }: { row: MachineRow }) {
  const can = useCan();
  const canSeeFiles = can('print_artifacts.read');
  const { current } = row;
  const runRecording = useQuery({
    ...recordingQuery(current?.id ?? ''),
    enabled: canSeeFiles && current?.kind === 'run',
  });
  const jobRecordings = useQuery({
    ...jobRecordingsQuery(current?.id ?? ''),
    enabled: canSeeFiles && current?.kind === 'job',
  });
  const recordings =
    current?.kind === 'run' ? (runRecording.data ? [runRecording.data] : []) : (jobRecordings.data?.items ?? []);
  const image = current ? thumbnailsOf(recordings, false)[0] : undefined;
  const maintenance = row.availability === 'maintenance';
  return (
    <figure className="mj-preview">
      <div className="mj-preview__stage">
        {image ? (
          <img src={image.src} alt={`${image.label} preview of ${image.fileName}`} />
        ) : (
          <div className="mj-preview__none">
            {current ? (
              <PlayFilledAlt size={32} aria-hidden />
            ) : maintenance ? (
              <WarningAlt size={32} aria-hidden />
            ) : (
              <NoImage size={32} aria-hidden />
            )}
            <span>
              {current
                ? currentItemName(current)
                : maintenance
                  ? 'In maintenance'
                  : row.availability === 'retired'
                    ? 'Retired'
                    : 'Idle'}
            </span>
            <small>{current ? 'No preview' : idleText(row)}</small>
          </div>
        )}
      </div>
      <figcaption className="mj-preview__caption">
        {current ? (
          <>
            <CarbonLink
              as={Link}
              size="sm"
              renderIcon={ArrowRight}
              to={current.kind === 'run' ? machineLogbookPaths.run(current.id) : machineLogbookPaths.job(current.id)}
            >
              {currentItemName(current)}
            </CarbonLink>
            <span className="mj-secondary">{currentStatusText(current)}</span>
          </>
        ) : (
          <>
            <span className="mj-secondary">
              {row.availability === 'available' ? 'Nothing running' : 'Not bookable'}
            </span>
            <span className="mj-secondary">—</span>
          </>
        )}
      </figcaption>
    </figure>
  );
}

function RecentJobs({ machineId }: { machineId: string }) {
  const jobs = useQuery(
    workItemsQuery({ machineId: [machineId], sort: 'startedAt', direction: 'desc', page: 1, pageSize: 4 }),
  );
  const items: WorkItem[] = jobs.data?.items ?? [];
  if (jobs.isPending) return <p className="mj-secondary">Loading jobs…</p>;
  if (jobs.isError) return <p className="mj-secondary">The jobs could not be loaded.</p>;
  if (items.length === 0) return <p className="mj-secondary">No jobs yet.</p>;
  return (
    <ul className="mj-panel-list">
      {items.map((item) => (
        <li key={item.id}>
          <Link
            className="mj-panel-list__row"
            to={item.kind === 'run' ? machineLogbookPaths.run(item.id) : machineLogbookPaths.job(item.id)}
          >
            <span className="mj-panel-list__main">
              <span className="mj-panel-list__title">{workItemName(item)}</span>
              <span className="mj-secondary">
                {formatRelative(item.startedAt)}
                {item.customer ? ` · ${item.customer.displayName}` : ''}
              </span>
            </span>
            <JobRowStatusTag status={item.status} size="sm" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** The machine panel next to the machines table: preview, head, actions, facts and the latest jobs. */
export function MachinePanel({
  row,
  onClose,
  onNewJob,
}: {
  row: MachineRow;
  onClose: () => void;
  onNewJob?: () => void;
}) {
  const can = useCan();
  const { machine } = row;
  const printer = isFdm(machine.process);
  const profile = useQuery({ ...printerQuery(machine.id), enabled: printer, retry: false });
  const live = useQuery({
    ...liveStatusQuery(machine.id),
    enabled: printer && row.connectorState !== 'none',
    refetchInterval: LIVE_REFRESH_MS,
  });
  const model = modelById(profile.data?.model)?.label;
  const status = live.data?.status;
  const spools = mountedSpoolLines(profile.data);
  const items: (SummaryItem | false)[] = [
    { label: 'Process', value: machine.process.name },
    {
      label: 'Collection',
      value: (
        <>
          {machine.automaticCollectionEnabled ? 'Automatic' : 'Manual'}{' '}
          <span className="mj-secondary">
            · {machine.automaticCollectionEnabled ? 'runs come from the connector' : 'runs are entered by hand'}
          </span>
        </>
      ),
    },
    row.connectorState !== 'none' && {
      label: 'Connector',
      value: (
        <>
          {connectorStateLabel(row.connector)}
          {row.connector?.lastHeartbeatAt && (
            <span className="mj-secondary"> · heartbeat {formatRelative(row.connector.lastHeartbeatAt)}</span>
          )}
        </>
      ),
    },
    printer &&
      Boolean(status) && {
        label: 'Printer',
        value: (
          <>
            {status!.state}
            {temperaturesText(status!) && <span className="mj-secondary"> · {temperaturesText(status!)}</span>}
          </>
        ),
      },
    printer &&
      Boolean(profile.data) && {
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
      },
    {
      label: 'Jobs',
      value: (
        <>
          {machine.jobCount}
          {row.lastJobAt && <span className="mj-secondary"> · last {formatRelative(row.lastJobAt)}</span>}
        </>
      ),
    },
    { label: 'Runtime', value: formatHours(machine.runtimeSeconds) },
    { label: 'Failure rate', value: `${formatQuantity(machine.failureRate, 1)} %` },
    Boolean(machine.externalIdentifier) && {
      label: 'External ID',
      value: machine.externalIdentifier,
      mono: true,
    },
  ];
  return (
    <DetailPanel className="mj-machine-panel">
      <MachinePreview row={row} />
      <DetailPanelHead
        title={machine.name}
        meta={[machine.process.name, model].filter(Boolean).join(' · ')}
        secondary={machine.externalIdentifier ?? undefined}
        helper={
          <span className="mj-inline">
            <AvailabilityTag availability={row.availability} size="sm" />
            {row.connectorState !== 'none' && <ConnectorStateTag connector={row.connector} />}
            <AttentionFlag attention={machine.attention} align="bottom" />
          </span>
        }
        actions={
          <IconButton kind="ghost" size="sm" label="Close panel" onClick={onClose}>
            <Close />
          </IconButton>
        }
      />
      <div className="mj-panel-actions">
        <Button as={Link} to={machineLogbookPaths.machine(machine.id)} size="md" renderIcon={ArrowRight}>
          Open machine
        </Button>
        {onNewJob && machine.status !== 'retired' && can('machine_jobs.create') && (
          <Button kind="tertiary" size="md" onClick={onNewJob}>
            New job
          </Button>
        )}
      </div>
      <SummaryList items={items} label="Machine facts" />
      {can('machine_jobs.read') && (
        <DetailPanelSection title="Recent jobs">
          <RecentJobs machineId={machine.id} />
        </DetailPanelSection>
      )}
    </DetailPanel>
  );
}
