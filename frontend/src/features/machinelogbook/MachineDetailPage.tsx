import { useState } from 'react';
import { Button, OverflowMenu, OverflowMenuItem } from '@carbon/react';
import { Add, ArrowLeft } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import type { PrinterProfile } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { MachineOverview } from './components/MachineOverview';
import { machineRow, PageSectionTabs } from './components/machineParts';
import { PrinterSetup } from './components/PrinterSetup';
import { DeleteMachineModal } from './dialogs/DeleteMachineModal';
import { JobFormModal } from './dialogs/JobFormModal';
import { JobsWorkspace } from './jobs/JobsPanels';
import { MachineSetupWizard } from './dialogs/MachineSetupWizard';
import { usePrinterConnection } from './connectorQueries';
import { isFdm } from './processConfig';
import { machineActivityQuery, machineQuery, printerQuery, workItemsQuery } from './queries';
import { machineLogbookPaths, machinePrinterSetupPath } from './shared/paths';
import { QueryBoundary } from './shared/QueryBoundary';
import { AvailabilityTag, ConnectorIssueTag, connectorIssue } from './shared/status';
import { useCan } from './shared/useCan';
import { useNow } from './shared/useNow';
import './styles/machines.scss';

type Section = 'overview' | 'jobs' | 'printer';

const sectionLabels: Record<Section, string> = { overview: 'Overview', jobs: 'Jobs', printer: 'Printer setup' };
const JOBS_LIMIT = 100;
// Runs reported by connectors appear without a reload.
const JOBS_REFRESH_MS = 10_000;
const PRINTER_REFRESH_MS = 5000;

/**
 * A machine's page: Overview and Jobs at /workshop/machines/:machineId (Jobs as ?tab=jobs) and the printer setup of
 * FDM printers at /workshop/machines/:machineId/printer.
 */
export function MachineDetailPage({ section: routeSection }: { section?: 'printer' }) {
  const { machineId = '' } = useParams();
  const can = useCan();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [editOpen, setEditOpen] = useState(false);
  const [jobOpen, setJobOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  useNow();
  const canManage = can('machines.manage');
  const canReadJobs = can('machine_jobs.read');
  const legacyPrinterTab = !routeSection && params.get('tab') === 'printer';
  const requested: Section = routeSection ?? (params.get('tab') === 'jobs' ? 'jobs' : 'overview');
  const printerSelected = requested === 'printer';
  const machineResult = useQuery(machineQuery(machineId));
  const activityResult = useQuery(machineActivityQuery());
  const printer = useQuery({
    ...printerQuery(machineId),
    retry: false,
    refetchInterval: printerSelected ? PRINTER_REFRESH_MS : false,
  });
  const jobsResult = useQuery({
    ...workItemsQuery({ machineId: [machineId], sort: 'startedAt', direction: 'desc', pageSize: JOBS_LIMIT }),
    enabled: canReadJobs && !legacyPrinterTab,
    refetchInterval: JOBS_REFRESH_MS,
  });

  const machine = machineResult.data;
  const profile: PrinterProfile | undefined = printer.data;
  const profileAbsent = printer.isError && printer.error instanceof ApiError && printer.error.status === 404;
  const showPrinter = Boolean(profile) || (canManage && isFdm(machine?.process));
  const { connection } = usePrinterConnection(
    machineId,
    can('printer_connectors.read') && showPrinter && !legacyPrinterTab,
    printerSelected ? PRINTER_REFRESH_MS : undefined,
  );
  const sections: Section[] = [
    'overview',
    ...(canReadJobs ? ['jobs' as const] : []),
    ...(showPrinter ? ['printer' as const] : []),
  ];
  const section: Section = sections.includes(requested) ? requested : 'overview';
  const pathOf = (key: string) =>
    key === 'printer'
      ? machinePrinterSetupPath(machineId)
      : key === 'jobs'
        ? `${machineLogbookPaths.machine(machineId)}?tab=jobs`
        : machineLogbookPaths.machine(machineId);

  const breadcrumbs = [
    { label: 'Workshop', to: machineLogbookPaths.home() },
    { label: 'Machines', to: machineLogbookPaths.machines() },
  ];
  // The printer setup used to be a tab of this page.
  if (legacyPrinterTab) return <Navigate to={machinePrinterSetupPath(machineId)} replace />;
  if (machineResult.isError && machineResult.error instanceof ApiError && machineResult.error.status === 404) {
    return (
      <PageShell title="Machine not found" breadcrumbs={breadcrumbs} width="wide">
        <EmptyState
          title="Machine not found"
          description="It may have been removed, or the link is wrong."
          action={
            <Button as={Link} to={machineLogbookPaths.machines()} kind="tertiary" renderIcon={ArrowLeft}>
              Back to machines
            </Button>
          }
        />
      </PageShell>
    );
  }
  if (!machine || activityResult.isPending || printer.isPending) {
    // Sections are only built once the printer profile is known, so the printer setup is selected from the start.
    const loading = {
      status: machineResult.isError ? 'error' : 'pending',
      data: undefined,
      refetch: machineResult.refetch,
    } as const;
    return (
      <PageShell title="Machine" breadcrumbs={breadcrumbs} width="wide">
        <QueryBoundary query={loading} errorMessage="The machine could not be loaded.">
          <></>
        </QueryBoundary>
      </PageShell>
    );
  }

  const row = machineRow(
    machine,
    activityResult.data?.items.find((item) => item.machineId === machineId),
  );
  const issue = row.availability === 'retired' ? null : connectorIssue(row.connector ?? undefined);
  const jobs = jobsResult.data?.items ?? [];
  const canCreate = machine.status !== 'retired' && can('machine_jobs.create');

  const actions = (
    <>
      {canManage && (
        <Button kind="secondary" onClick={() => setEditOpen(true)}>
          Edit machine
        </Button>
      )}
      {canCreate && (
        <Button renderIcon={Add} onClick={() => setJobOpen(true)}>
          New job
        </Button>
      )}
      {canManage && (
        <OverflowMenu aria-label="More machine actions" iconDescription="More machine actions" flipped size="lg">
          <OverflowMenuItem itemText="Delete machine" isDelete onClick={() => setDeleteOpen(true)} />
        </OverflowMenu>
      )}
    </>
  );

  return (
    <PageShell
      title={machine.name}
      titleAdornment={
        <span className="mj-inline">
          <AvailabilityTag availability={row.availability} />
          <ConnectorIssueTag issue={issue} />
        </span>
      }
      breadcrumbs={[...breadcrumbs, { label: machine.name }]}
      actions={actions}
      width="wide"
      tabs={
        <PageSectionTabs
          label="Machine sections"
          sections={sections.map((id) => ({ id, label: sectionLabels[id] }))}
          selected={section}
          onChange={(id) => navigate(pathOf(id), { replace: true })}
        />
      }
    >
      {section === 'overview' && (
        <MachineOverview
          row={row}
          profile={profile}
          connection={connection}
          jobs={jobs}
          jobsQuery={canReadJobs ? jobsResult : null}
          onShowJobs={() => navigate(pathOf('jobs'), { replace: true })}
        />
      )}
      {section === 'jobs' && <JobsWorkspace machineColumn={false} machineId={machine.id} urlPrefix="jobs." />}
      {section === 'printer' && (
        <QueryBoundary
          query={{ status: profileAbsent ? 'success' : printer.status, data: profile, refetch: printer.refetch }}
          errorMessage="Printer setup could not be loaded."
        >
          <PrinterSetup machine={machine} profile={profile} connection={connection} active />
        </QueryBoundary>
      )}
      {canManage && editOpen && (
        <MachineSetupWizard
          open
          onClose={() => setEditOpen(false)}
          machine={machine}
          profile={profile}
          connection={connection}
          initialStep="machine"
        />
      )}
      {canManage && <DeleteMachineModal machine={machine} open={deleteOpen} onClose={() => setDeleteOpen(false)} />}
      {canCreate && (
        <JobFormModal
          open={jobOpen}
          onClose={() => setJobOpen(false)}
          mode="create"
          initialValues={{ machineId: machine.id }}
        />
      )}
    </PageShell>
  );
}
