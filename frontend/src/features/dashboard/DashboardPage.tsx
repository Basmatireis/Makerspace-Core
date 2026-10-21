import { Button } from '@carbon/react';
import { UserMultiple } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useNow } from '../../app/useNow';
import { useCurrentUser } from '../auth/auth';
import { canAccessOpenDays, hasPermission, PermissionId } from '../auth/permissions';
import { ComingUpPanel } from './ComingUpPanel';
import { NextOpenDayTile, UpcomingOpenDaysList } from './GuestOpenDays';
import { LabRulesNotice, LabRulesTile } from './LabRules';
import { NextUpTile } from './NextUpTile';
import { SemesterTile } from './SemesterTile';
import { StatisticsSection } from './StatisticsSection';
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
  const solo = data.staffing === undefined && labRulesStatus === undefined;

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
      <div className={solo ? 'db-grid db-grid--solo' : 'db-grid'}>
        {data.staffing ? (
          <>
            <div className="db-area-next">
              <NextUpTile
                next={comingUp[0] ?? null}
                total={comingUp.length}
                staffing={data.staffing}
                now={now}
                canSignUp={canSignUp}
                canFindOpenDays={canFindOpenDays}
              />
            </div>
            <div className="db-area-semester">
              <SemesterTile staffing={data.staffing} canFindOpenDays={canFindOpenDays} />
            </div>
          </>
        ) : (
          <>
            <div className="db-area-next">
              {labRulesStatus ? (
                <LabRulesTile status={labRulesStatus} />
              ) : (
                <NextOpenDayTile next={upcoming[0]} now={now} />
              )}
            </div>
            {labRulesStatus && (
              <div className="db-area-semester">
                <NextOpenDayTile next={upcoming[0]} now={now} />
              </div>
            )}
          </>
        )}
        {data.statistics && (
          <div className="db-area-stats">
            <StatisticsSection statistics={data.statistics} now={now} />
          </div>
        )}
        {(data.staffing || comingUp.length > 0 || upcoming.length > 0 || data.staffing === undefined) && (
          <div className="db-area-coming">
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
      </div>
    </PageShell>
  );
}
