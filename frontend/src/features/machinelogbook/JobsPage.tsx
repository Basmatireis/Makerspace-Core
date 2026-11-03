import { PageShell } from '../../app/PageShell';
import { JobsWorkspace } from './jobs/JobsPanels';
import { machineLogbookPaths } from './shared/paths';
import './styles/jobs.scss';

/** Jobs of the Workshop: runs reported without a job, the jobs table and the detail panel of the selection. */
export function JobsPage() {
  return (
    <PageShell
      title="Jobs"
      description="Billable work on machines, one job per machine and recipient, with the runs that make it up."
      width="wide"
      breadcrumbs={[{ label: 'Workshop', to: machineLogbookPaths.home() }, { label: 'Jobs' }]}
    >
      <JobsWorkspace />
    </PageShell>
  );
}
