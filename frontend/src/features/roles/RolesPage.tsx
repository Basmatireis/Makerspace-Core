import {
  Button,
  DataTable,
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
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { listRoles } from '../../api/generated/roles/roles';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { roleKeys } from './queries';

export function RolesPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const rolesQuery = useInfiniteQuery({
    queryKey: roleKeys.lists(),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam, signal }) =>
      listRoles({ limit: 100, ...(pageParam ? { cursor: pageParam } : {}) }, { signal }),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });
  const roles = rolesQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const rows = roles.map((role) => ({
    id: role.id,
    name: role.name,
    type: role.systemKey === 'master' ? 'System' : 'Custom',
    permissions: String(role.permissionIds.length),
  }));
  const headers = [
    { key: 'name', header: 'Role' },
    { key: 'type', header: 'Type' },
    { key: 'permissions', header: 'Permissions' },
  ];

  return (
    <Stack gap={7}>
      <PageHeader
        title="Roles"
        breadcrumbs={[{ label: 'Settings', to: '/settings' }]}
        description="Configure permission sets that can be assigned to accounts."
        actions={hasPermission(currentUser, PermissionId.rolesmanage) ? (
          <Button renderIcon={Add} onClick={() => navigate('/settings/roles/new')}>Create role</Button>
        ) : undefined}
      />
      {rolesQuery.isPending && <InlineLoadingState label="Loading roles" />}
      {rolesQuery.isError && <ErrorState title="Unable to load roles" message="Check the connection and try again." onRetry={() => void rolesQuery.refetch()} />}
      {rolesQuery.data && (
        <Stack gap={5}>
          <DataTable rows={rows} headers={headers}>
            {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => (
              <TableContainer title="Configured roles">
                <Table {...getTableProps()}>
                  <TableHead><TableRow>{tableHeaders.map((header) => <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>)}</TableRow></TableHead>
                  <TableBody>
                    {tableRows.map((row) => <TableRow {...getRowProps({ row })} key={row.id}>{row.cells.map((cell, index) => <TableCell key={cell.id}>{index === 0 ? <CarbonLink href={`/settings/roles/${row.id}`} onClick={(event) => { event.preventDefault(); navigate(`/settings/roles/${row.id}`); }}>{String(cell.value)}</CarbonLink> : cell.info.header === 'type' ? <Tag type={cell.value === 'System' ? 'purple' : 'blue'}>{String(cell.value)}</Tag> : String(cell.value)}</TableCell>)}</TableRow>)}
                  </TableBody>
                </Table>
                {rows.length === 0 && <div className="empty-state"><h2>No roles found</h2><p>Create a role to group permissions.</p></div>}
              </TableContainer>
            )}
          </DataTable>
          {rolesQuery.hasNextPage && <Button kind="tertiary" disabled={rolesQuery.isFetchingNextPage} onClick={() => void rolesQuery.fetchNextPage()}>{rolesQuery.isFetchingNextPage ? 'Loading…' : 'Load more roles'}</Button>}
        </Stack>
      )}
    </Stack>
  );
}
