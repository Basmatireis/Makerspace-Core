import { Button } from '@carbon/react';
import { UserMultiple } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useNow } from '../../app/useNow';
import { useCurrentUser } from '../auth/auth';
import { canAccessOpenDays, hasPermission, PermissionId } from '../auth/permissions';
import { BalanceTile } from './BalanceTile';
import { ComingUpPanel } from './ComingUpPanel';
import { NextOpenDayTile, UpcomingOpenDaysList } from './GuestOpenDays';
import { LabRulesNotice, LabRulesTile } from './LabRules';
import { JobsPerMonth } from './JobsPerMonth';
import { NextUpTile } from './NextUpTile';
import { PayDialog } from './PayDialog';
import { RecentJobsPanel, RecentOrdersPanel } from './RecentPanels';
import { SemesterTile } from './SemesterTile';
import { StatisticsSection } from './StatisticsSection';
import { jobItems, orderItems, payableOrders } from './balance';
import { greeting, longToday, plural, upcomingOpenDays } from './format';
import { ownLabRulesOptions, personalDashboardOptions, publicOpenDaysOptions } from './queries';
import './dashboard.scss';

const WEEK_MS = 7 * 86_400_000;

/**
 * The landing page. Sections follow what the API returns and what the person may do: a person with a staffing level
 * gets the staffing sections; everyone else sees their lab rules status and the next open days.
 */
export function DashboardPage() {
  const currentUser = useCurrentUser();
  const now = useNow();
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
  const thisWeek = comingUp.filter((item) => new Date(item.startsAt).getTime() - now < WEEK_MS).length;
  const today = longToday(now);
  const description =
    comingUp.length === 0 && !data.staffing
      ? today
      : `${today} · ${
          thisWeek === 0 ? 'nothing planned this week' : `${plural(thisWeek, 'commitment')} in the next 7 days`
        }`;
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
  const jobStats = data.statistics?.jobs;
  const jobsChart = jobStats && jobStats.jobs > 0 ? <JobsPerMonth months={jobStats.jobsPerMonth} /> : null;
  const showComing = data.staffing || comingUp.length > 0 || upcoming.length > 0 || data.staffing === undefined;

  return (
    <PageShell
      title={`${greeting(now)}, ${data.person.firstName}`}
      description={description}
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
        <div className="db-row">
          {data.staffing ? (
            <>
              <NextUpTile
                next={comingUp[0] ?? null}
                total={comingUp.length}
                staffing={data.staffing}
                now={now}
                canSignUp={canSignUp}
                canFindOpenDays={canFindOpenDays}
              />
              <SemesterTile staffing={data.staffing} canFindOpenDays={canFindOpenDays} />
            </>
          ) : (
            <>
              {labRulesStatus ? (
                <LabRulesTile status={labRulesStatus} />
              ) : (
                <NextOpenDayTile next={upcoming[0]} now={now} />
              )}
              {labRulesStatus && <NextOpenDayTile next={upcoming[0]} now={now} />}
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
        </div>
        {data.statistics && <StatisticsSection statistics={data.statistics} now={now} />}
        {(showComing || data.recentJobs) && (
          <div className="db-row db-row--pair">
            {showComing && (
              <div>
                {data.staffing === undefined && <UpcomingOpenDaysList days={upcoming} now={now} />}
                {(data.staffing !== undefined || comingUp.length > 0) && (
                  <ComingUpPanel
                    items={comingUp}
                    now={now}
                    canLeave={canSignUp}
                    canFindOpenDays={canFindOpenDays && data.staffing !== undefined}
                  />
                )}
              </div>
            )}
            {data.recentJobs && <RecentJobsPanel jobs={data.recentJobs} />}
          </div>
        )}
        {(data.recentOrders || jobsChart) && (
          <div className="db-row db-row--pair">
            {data.recentOrders && (
              <RecentOrdersPanel
                orders={data.recentOrders}
                payableIds={payOrderIds}
                onPay={(order) => setPaying([order.id])}
              />
            )}
            {jobsChart}
          </div>
        )}
      </div>
      {balance && paying !== null && (
        <PayDialog balance={balance} initialSelected={paying} canPayJobs={canPayJobs} onClose={() => setPaying(null)} />
      )}
    </PageShell>
  );
}
