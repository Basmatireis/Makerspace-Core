import { useState } from 'react';
import { Button, ClickableTile, InlineNotification } from '@carbon/react';
import { Settings } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { SupervisorRow } from '../../api/generated/models';
import { getSupervisorDashboard } from '../../api/generated/supervisors/supervisors';
import type { FilterValues } from '../../app/BatchFilter';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { PromoteDialog } from './PromoteDialog';
import { StaffingTable } from './StaffingTable';
import { filterRows, isTileActive } from './staffing';
import './staffing.scss';

type MetricProps = {
  label: string;
  value: number;
  detail: string;
  active: boolean;
  onClick: () => void;
};

/** A key figure that filters the table; clicking the active one again clears its filter. */
function Metric({ label, value, detail, active, onClick }: MetricProps) {
  return (
    <ClickableTile
      className={`staffing-metric${active ? ' staffing-metric--active' : ''}`}
      onClick={onClick}
      role="button"
      aria-pressed={active}
    >
      <span className="staffing-metric__label">{label}</span>
      <span
        className={`staffing-metric__value ${value > 0 ? 'staffing-metric__value--bad' : 'staffing-metric__value--zero'}`}
      >
        {value}
      </span>
      <span className="staffing-secondary">{detail}</span>
    </ClickableTile>
  );
}

export function SupervisorStaffingPage() {
  const currentUser = useCurrentUser();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<FilterValues>({});
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [promoting, setPromoting] = useState<SupervisorRow | null>(null);
  const [promoted, setPromoted] = useState<string | null>(null);
  const canOpenPeople = hasPermission(currentUser, PermissionId.peoplereadall);
  const canAssignRoles = hasPermission(currentUser, PermissionId.peoplerolesassign);
  const canManageRequirements = hasPermission(currentUser, PermissionId.open_daysmanage);
  const query = useQuery({
    queryKey: ['supervisor-dashboard'],
    queryFn: ({ signal }) => getSupervisorDashboard(undefined, { signal }),
  });

  if (query.isPending) return <FullPageLoading label="Loading supervisor staffing" />;
  if (query.isError || !query.data) {
    return (
      <ErrorState
        title="Unable to load supervisor staffing"
        message="Check the connection and try again."
        onRetry={() => void query.refetch()}
      />
    );
  }

  const { semester, rules, supervisors } = query.data;
  const applyFilters = (values: FilterValues) => {
    setFilters(values);
    setPage(1);
  };
  const tile = (key: string, value: string) => ({
    active: isTileActive(filters, key, value),
    onClick: () => applyFilters(isTileActive(filters, key, value) ? {} : { [key]: [value] }),
  });
  const visible = filterRows(supervisors, search, filters);
  const below = supervisors.filter((row) => row.status === 'missing').length;
  const unsigned = supervisors.filter((row) => row.laborordnungState === 'outdated').length;
  const ready = supervisors.filter((row) => row.status === 'ready').length;
  const noPhoto = supervisors.filter((row) => !row.hasProfileImage).length;
  const hasTrainees = supervisors.some((row) => row.membership === 'trainee');

  let promoteBlockedReason: string | null = null;
  if (!canAssignRoles) {
    promoteBlockedReason = 'You need permission to assign roles to make a trainee a supervisor.';
  }

  return (
    <PageShell
      title="Supervisor staffing"
      breadcrumbs={[
        { label: 'Directory' },
        ...(canOpenPeople ? [{ label: 'People', to: '/people' }] : []),
        { label: 'Members' },
      ]}
      width="wide"
      className="supervisor-staffing-page"
      actions={
        canManageRequirements ? (
          <Button as={Link} to="/settings/open-days" kind="tertiary" renderIcon={Settings}>
            Requirements
          </Button>
        ) : undefined
      }
    >
      <section className="supervisor-staffing-main" aria-label="Members table">
        {semester === null && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="No open-day period"
            subtitle="Members are shown without open-day counts."
          />
        )}
        {promoted && (
          <InlineNotification
            kind="success"
            lowContrast
            title={`${promoted} is now a supervisor`}
            subtitle="They take supervisor places from now on."
            onCloseButtonClick={() => setPromoted(null)}
          />
        )}
        {hasTrainees && promoteBlockedReason && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Making supervisors"
            subtitle={promoteBlockedReason}
          />
        )}

        <section aria-label="Key figures" className="staffing-metrics">
          <Metric
            label="Below minimum"
            value={below}
            detail={below ? 'Not signed up for enough open days' : 'Everyone is signed up for the minimum'}
            {...tile('status', 'missing')}
          />
          <Metric
            label="Lab rules not signed"
            value={unsigned}
            detail="Current version missing"
            {...tile('labRules', 'outdated')}
          />
          <Metric
            label="Ready for supervisor"
            value={ready}
            detail={`Trainees with ${rules.traineeReadyAfter}+ open days`}
            {...tile('status', 'ready')}
          />
          <Metric
            label="No profile picture"
            value={noPhoto}
            detail="Profile picture missing"
            {...tile('photo', 'missing')}
          />
        </section>

        <StaffingTable
          rows={visible}
          traineeThreshold={rules.traineeReadyAfter}
          search={search}
          filters={filters}
          page={page}
          pageSize={pageSize}
          canOpenPeople={canOpenPeople}
          promoteBlockedReason={promoteBlockedReason}
          hasAnyRows={supervisors.length > 0}
          onSearch={(value) => {
            setSearch(value);
            setPage(1);
          }}
          onFilters={applyFilters}
          onPage={(nextPage, nextPageSize) => {
            setPage(nextPage);
            setPageSize(nextPageSize);
          }}
          onPromote={(row) => {
            setPromoted(null);
            setPromoting(row);
          }}
        />
      </section>
      <PromoteDialog
        member={promoting}
        threshold={rules.traineeReadyAfter}
        onClose={() => setPromoting(null)}
        onPromoted={setPromoted}
      />
    </PageShell>
  );
}
