import { Button } from '@carbon/react';
import { UserMultiple } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Suspense, lazy, useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useNow } from '../../app/useNow';
import { useCurrentUser } from '../auth/auth';
import { useBranding } from '../branding/branding';
import { canAccessOpenDays, hasAnyPermission, hasPermission, PermissionId } from '../auth/permissions';
import { BalanceTile } from './BalanceTile';
import { ComingUpPanel } from './ComingUpPanel';
import { NextOpenDayTile, UpcomingOpenDaysList } from './GuestOpenDays';
import { LabRulesNotice, LabRulesTile } from './LabRules';
import PinboardSkeleton from '../workinggroups/PinboardSkeleton';
import { NextUpTile } from './NextUpTile';
import { PayDialog } from './PayDialog';
import { RecentJobsPanel, RecentOrdersPanel } from './RecentPanels';
import { StatisticsSection } from './StatisticsSection';
import { jobItems, orderItems, payableOrders } from './balance';
import { pickGreeting, replayRandom, upcomingOpenDays } from './format';
import { ownLabRulesOptions, personalDashboardOptions, publicOpenDaysOptions } from './queries';
import './dashboard.scss';

// The working-groups part is its own chunk: the first paint of the dashboard does not wait for it.
const DashboardPinboard = lazy(() => import('../workinggroups/DashboardPinboard'));

/**
 * The landing page. Sections follow what the API returns and what the person may do: a person with a staffing level
 * gets the staffing sections; everyone else sees their lab rules status and the next open days.
 */
export function DashboardPage() {
  const currentUser = useCurrentUser();
  const now = useNow();
  const { funGreetings, funGreetingShare } = useBranding().identity;
  // Drawn once per visit so the title does not change on every render (the clock ticks).
  const [rolls] = useState(() => [Math.random(), Math.random()]);
  const dashboard = useQuery(personalDashboardOptions);
  const labRules = useQuery(ownLabRulesOptions);
  /** Ids ticked in the pay dialog; null while it is closed. */
  const [paying, setPaying] = useState<string[] | null>(null);
  const staffed = dashboard.data?.staffing !== undefined;
  const publicDays = useQuery({ ...publicOpenDaysOptions, enabled: dashboard.isSuccess && !staffed });

  if (dashboard.isPending || dashboard.isError) {
    return (
      <PageShell title="Dashboard" width="wide">
        {dashboard.isPending ? (
          <FullPageLoading label="Loading your dashboard" />
        ) : (
          <ErrorState
            title="Unable to load your dashboard"
            message="Check the connection and try again."
            onRetry={() => void dashboard.refetch()}
          />
        )}
      </PageShell>
    );
  }

  const data = dashboard.data;
  const canFindOpenDays = canAccessOpenDays(currentUser);
  const canSignUp = hasPermission(currentUser, PermissionId.open_dayssignup);
  const comingUp = (data.comingUp ?? []).filter((item) => new Date(item.endsAt).getTime() > now);
  const labRulesStatus = labRules.data;
  const upcoming = upcomingOpenDays(publicDays.data?.items ?? [], now);
  const balance = data.balance;
  const canPay =
    hasPermission(currentUser, PermissionId.ordersread) &&
    hasPermission(currentUser, PermissionId.paymentsread) &&
    hasPermission(currentUser, PermissionId.paymentsrecord);
  const canPayJobs =
    canPay &&
    hasPermission(currentUser, PermissionId.orderswrite) &&
    hasPermission(currentUser, PermissionId.ordersfinalize);
  const payOrderIds = new Set(canPay && balance ? payableOrders(balance).map((order) => order.id) : []);
  const payItems = balance ? [...orderItems(balance), ...(canPayJobs ? jobItems(balance) : [])] : [];
  const canOpenEvents = hasAnyPermission(currentUser, [
    'events.read',
    'events.manage',
    'events.staffing.manage',
    'events.assign',
  ]);
  const pinboard = hasPermission(currentUser, PermissionId.working_groupsread);
  // The wide column holds the pinboard; without it the side tiles share the row.
  const wide = pinboard;

  return (
    <PageShell
      title={pickGreeting({
        now,
        firstName: data.person.firstName,
        funGreetings,
        funGreetingShare,
        random: replayRandom(rolls),
      })}
      breadcrumbs={[{ label: 'Dashboard' }]}
      width="wide"
      actions={
        <Button as={Link} to="/profile" kind="tertiary" renderIcon={UserMultiple}>
          My profile
        </Button>
      }
    >
      {data.staffing && labRulesStatus && (
        <div className="db-notices">
          <LabRulesNotice status={labRulesStatus} />
        </div>
      )}
      <div className="db-grid">
        {data.statistics && <StatisticsSection statistics={data.statistics} now={now} />}
        <div className={`db-main${wide ? '' : ' db-main--single'}`}>
          {wide && (
            <div className="db-main__wide">
              {pinboard && (
                <Suspense fallback={<PinboardSkeleton />}>
                  <DashboardPinboard />
                </Suspense>
              )}
            </div>
          )}
          <div className="db-main__side">
            {data.staffing ? (
              <NextUpTile
                items={comingUp}
                staffing={data.staffing}
                now={now}
                canSignUp={canSignUp}
                canFindOpenDays={canFindOpenDays}
                canOpenEvents={canOpenEvents}
              />
            ) : (
              <>
                {labRulesStatus && <LabRulesTile status={labRulesStatus} />}
                <NextOpenDayTile next={upcoming[0]} now={now} />
              </>
            )}
            {balance && (
              <BalanceTile
                balance={balance}
                canPay={canPay}
                canPayJobs={canPayJobs}
                hasPayable={payItems.length > 0}
                onPay={() => setPaying(payItems.map((item) => item.id))}
              />
            )}
            {data.recentJobs && <RecentJobsPanel jobs={data.recentJobs} />}
            {data.recentOrders && (
              <RecentOrdersPanel
                orders={data.recentOrders}
                payableIds={payOrderIds}
                onPay={(order) => setPaying([order.id])}
              />
            )}
            {data.staffing === undefined && <UpcomingOpenDaysList days={upcoming} now={now} />}
            {data.staffing === undefined && comingUp.length > 0 && (
              <ComingUpPanel items={comingUp} now={now} canLeave={canSignUp} canFindOpenDays={false} />
            )}
          </div>
        </div>
      </div>
      {balance && paying !== null && (
        <PayDialog balance={balance} initialSelected={paying} canPayJobs={canPayJobs} onClose={() => setPaying(null)} />
      )}
    </PageShell>
  );
}
