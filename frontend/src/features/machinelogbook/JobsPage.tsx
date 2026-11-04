import { useSearchParams } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { PageSectionTabs } from './components/machineParts';
import { JobsWorkspace } from './jobs/JobsPanels';
import { JobsRecycleBin } from './RecycleBinPage';
import { machineLogbookPaths } from './shared/paths';
import './styles/jobs.scss';

type JobsTab = 'all' | 'attention' | 'bin';
const TABS: { id: JobsTab; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'bin', label: 'Recycle bin' },
];

/** Jobs of the Workshop: all jobs, the ones that need attention, and the recycle bin, each with its detail panel. */
export function JobsPage() {
  const [params, setParams] = useSearchParams();
  const tab: JobsTab = TABS.find((section) => section.id === params.get('tab'))?.id ?? 'all';
  return (
    <PageShell
      title="Jobs"
      width="wide"
      breadcrumbs={[{ label: 'Workshop', to: machineLogbookPaths.home() }, { label: 'Jobs' }]}
      tabs={
        <PageSectionTabs
          label="Jobs sections"
          guide="workshop-jobs-tabs"
          sections={TABS}
          selected={tab}
          onChange={(id) => setParams(id === 'all' ? {} : { tab: id }, { replace: true })}
        />
      }
    >
      {tab === 'all' && <JobsWorkspace key="all" />}
      {tab === 'attention' && <JobsWorkspace key="attention" attention />}
      {tab === 'bin' && <JobsRecycleBin />}
    </PageShell>
  );
}
