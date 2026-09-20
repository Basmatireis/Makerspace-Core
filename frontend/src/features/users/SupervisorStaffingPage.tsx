import {
  Button,
  DataTable,
  InlineNotification,
  Link as CarbonLink,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  Tile,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { getSupervisorDashboard } from '../../api/generated/supervisors/supervisors';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { canAccessOpenDays, hasPermission, PermissionId } from '../auth/permissions';

function periodColumnKey(periodId: string): string {
  return `period-${periodId}`;
}

function labRulesLabel(state: string): string {
  return state.replaceAll('_', ' ').replace(/^./, (value) => value.toUpperCase());
}

export function SupervisorStaffingPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const canOpenPeople = hasPermission(currentUser, PermissionId.peoplereadall);
  const canOpenPeriods = canAccessOpenDays(currentUser);
  const query = useQuery({
    queryKey: ['supervisor-dashboard'],
    queryFn: ({ signal }) => getSupervisorDashboard({ signal }),
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

  const dashboard = query.data;
  const periodByColumn = new Map(
    dashboard.periods.map((period) => [periodColumnKey(period.id), period]),
  );
  const headers = [
    { key: 'name', header: 'Supervisor' },
    { key: 'photo', header: 'Profile picture' },
    { key: 'laborordnung', header: 'Lab Rules' },
    ...dashboard.periods.map((period) => ({
      key: periodColumnKey(period.id),
      header: period.name,
    })),
  ];
  const rows = dashboard.supervisors.map((supervisor) => ({
    id: supervisor.personId,
    name: supervisor.name,
    photo: supervisor.hasProfileImage ? 'Complete' : 'Missing',
    laborordnung: supervisor.laborordnungState,
    ...Object.fromEntries(
      dashboard.periods.map((period) => [
        periodColumnKey(period.id),
        supervisor.assignmentCounts.find((count) => count.periodId === period.id)?.count ?? 0,
      ]),
    ),
  }));

  return (
    <Stack gap={7} className="supervisor-staffing-page">
      <PageHeader
        title="Supervisor staffing"
        breadcrumbs={[
          { label: 'Settings', to: '/settings' },
          ...(canOpenPeople ? [{ label: 'People', to: '/settings/users' }] : [{ label: 'People' }]),
          { label: 'Supervisor staffing' },
        ]}
        description="Profile-picture readiness, Lab Rules status, and staffing across active Open Day periods."
        actions={canOpenPeople ? (
          <Button kind="tertiary" onClick={() => navigate('/settings/users')}>
            People directory
          </Button>
        ) : undefined}
      />

      <div className="summary-grid" aria-label="Supervisor staffing summary">
        <Tile><strong>{dashboard.totals.supervisors}</strong><p>Designated supervisors</p></Tile>
        <Tile><strong>{dashboard.totals.profileImagesComplete}</strong><p>Profile pictures complete</p></Tile>
        <Tile><strong>{dashboard.totals.laborordnungCurrent}</strong><p>Lab Rules current</p></Tile>
        <Tile><strong>{dashboard.totals.laborordnungOutdated}</strong><p>Lab Rules need attention</p></Tile>
      </div>

      {dashboard.periods.length === 0 && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="No active staffing periods"
          subtitle="Designated supervisors are shown without assignment columns."
        />
      )}

      <DataTable rows={rows} headers={headers}>
        {({ rows: tableRows, headers: tableHeaders, getTableProps, getHeaderProps, getRowProps }) => (
          <TableContainer title="Designated supervisors" className="supervisor-staffing-table">
            <Table {...getTableProps()}>
              <TableHead>
                <TableRow>
                  {tableHeaders.map((header) => {
                    const period = periodByColumn.get(header.key);
                    return (
                      <TableHeader {...getHeaderProps({ header })} key={header.key}>
                        {period ? (
                          <div className="supervisor-period-header">
                            {canOpenPeriods ? (
                              <CarbonLink
                                href={`/open-days/${period.id}`}
                                onClick={(event) => {
                                  event.preventDefault();
                                  navigate(`/open-days/${period.id}`);
                                }}
                              >
                                {period.name}
                              </CarbonLink>
                            ) : (
                              <span>{period.name}</span>
                            )}
                            <Tag size="sm" type={period.status === 'published' ? 'green' : 'blue'}>
                              {period.status}
                            </Tag>
                            <span className="supervisor-period-header__count">
                              {period.supervisorAssignments} assignments
                            </span>
                          </div>
                        ) : header.header}
                      </TableHeader>
                    );
                  })}
                </TableRow>
              </TableHead>
              <TableBody>
                {tableRows.map((row) => (
                  <TableRow {...getRowProps({ row })} key={row.id}>
                    {row.cells.map((cell) => (
                      <TableCell key={cell.id}>
                        {cell.info.header === 'name' && canOpenPeople ? (
                          <CarbonLink
                            href={`/settings/users/${row.id}`}
                            onClick={(event) => {
                              event.preventDefault();
                              navigate(`/settings/users/${row.id}`);
                            }}
                          >
                            {String(cell.value)}
                          </CarbonLink>
                        ) : cell.info.header === 'photo' ? (
                          <Tag type={cell.value === 'Complete' ? 'green' : 'red'}>{String(cell.value)}</Tag>
                        ) : cell.info.header === 'laborordnung' ? (
                          <Tag type={cell.value === 'current' || cell.value === 'not_required' ? 'green' : 'red'}>
                            {labRulesLabel(String(cell.value))}
                          </Tag>
                        ) : (
                          String(cell.value)
                        )}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {rows.length === 0 && (
              <div className="empty-state">
                <h2>No designated supervisors</h2>
                <p>Assign a role configured as a supervisor role to include someone here.</p>
              </div>
            )}
          </TableContainer>
        )}
      </DataTable>
    </Stack>
  );
}
