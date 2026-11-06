import './opendays.scss';
import { useQuery } from '@tanstack/react-query';
import { Navigate, useSearchParams } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';
import { SectionTabs } from './components/SectionTabs';
import { dateOf } from './model/dates';
import { currentPeriod } from './model/currentPeriod';
import { BreaksTab } from './periods/BreaksTab';
import { PeriodsTab } from './periods/PeriodsTab';
import { periodsQueryOptions } from './queries';

/** People without `open_days.manage` skip the period list and land on the schedule of the current period. */
function CurrentPeriodRedirect() {
  const periods = useQuery(periodsQueryOptions());
  if (periods.isPending)
    return (
      <PageShell title="Open Days">
        <InlineLoadingState label="Loading Open Days" />
      </PageShell>
    );
  if (periods.isError)
    return (
      <PageShell title="Open Days">
        <ErrorState
          title="Unable to load Open Days"
          message="Check the connection and try again."
          onRetry={() => void periods.refetch()}
        />
      </PageShell>
    );
  const period = currentPeriod(periods.data.items, dateOf(new Date()));
  if (!period)
    return (
      <PageShell title="Open Days">
        <EmptyState
          title="No open days planned yet"
          description="Check again once the next period has been published."
        />
      </PageShell>
    );
  return <Navigate to={`/open-days/${period.id}`} replace />;
}

/** `/open-days`: the period list with the Breaks tab for the Leitung; everyone else is sent to the schedule. */
export function OpenDaysPage() {
  const user = useCurrentUser();
  if (!hasPermission(user, 'open_days.manage')) return <CurrentPeriodRedirect />;
  return <PeriodsPage canSignUp={hasPermission(user, 'open_days.signup')} />;
}

function PeriodsPage({ canSignUp }: { canSignUp: boolean }) {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'breaks' ? 'breaks' : 'periods';
  return (
    <PageShell
      title="Open Days"
      width="fluid"
      className="open-days-page"
      tabs={
        <SectionTabs
          label="Open Days sections"
          sections={[
            { id: 'periods', label: 'Periods' },
            { id: 'breaks', label: 'Breaks' },
          ]}
          selected={tab}
          onChange={(id) => setParams(id === 'breaks' ? { tab: 'breaks' } : {}, { replace: true })}
        />
      }
    >
      <div className="od-page">
        {tab === 'breaks' ? <BreaksTab /> : <PeriodsTab initialId={params.get('period')} canSignUp={canSignUp} />}
      </div>
    </PageShell>
  );
}
