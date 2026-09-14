import { useEffect, useState } from 'react';
import {
  Button,
  DataTable,
  Link as CarbonLink,
  Pagination,
  Search,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  TableToolbar,
  TableToolbarContent,
} from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { peopleListOptions } from './queries';

const PAGE_SIZES = [10, 25, 50, 100];

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function UsersPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = positiveInteger(searchParams.get('page'), 1);
  const pageSize = Math.min(100, positiveInteger(searchParams.get('pageSize'), 25));
  const search = searchParams.get('search') ?? '';
  const [searchValue, setSearchValue] = useState(search);

  useEffect(() => setSearchValue(search), [search]);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const normalized = searchValue.trim();
      if (normalized === search) return;
      const next = new URLSearchParams(searchParams);
      next.set('page', '1');
      if (normalized) next.set('search', normalized);
      else next.delete('search');
      setSearchParams(next, { replace: true });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [search, searchParams, searchValue, setSearchParams]);

  const peopleQuery = useQuery(
    {
      ...peopleListOptions({ page, pageSize, ...(search ? { search } : {}) }),
      placeholderData: keepPreviousData,
    },
  );
  const mayCreate = hasPermission(currentUser, PermissionId.peoplecreate);
  const showMatriculation = hasPermission(
    currentUser,
    PermissionId.peoplereadmatriculation,
  );
  const showAccounts = hasPermission(currentUser, PermissionId.accountsread);

  const headers = [
    { key: 'name', header: 'Name' },
    { key: 'contact', header: 'Contact' },
    ...(showMatriculation
      ? [{ key: 'matriculationNumber', header: 'Matriculation number' }]
      : []),
    ...(showAccounts
      ? [
          { key: 'account', header: 'Account' },
          { key: 'roles', header: 'Roles' },
        ]
      : []),
  ];
  const rows = (peopleQuery.data?.items ?? []).map((person) => ({
    id: person.id,
    name: `${person.firstName} ${person.lastName}`,
    contact: person.email ?? person.phone ?? 'Not provided',
    ...(showMatriculation
      ? { matriculationNumber: person.matriculationNumber ?? 'Not provided' }
      : {}),
    ...(showAccounts
      ? {
          account:
            person.account === undefined
              ? 'Restricted'
              : person.account === null
                ? 'No account'
                : person.account.status,
          roles:
            person.account === undefined
              ? 'Restricted'
              : person.account === null || person.account.roles.length === 0
                ? '—'
                : person.account.roles.map((role) => role.name).join(', '),
        }
      : {}),
  }));

  return (
    <Stack gap={7}>
      <PageHeader
        title="Members"
        breadcrumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Members' }]}
        description="Manage member records and their optional login accounts."
      />

      {peopleQuery.isPending && <InlineLoadingState label="Loading members" />}
      {peopleQuery.isError && (
        <ErrorState
          title="Unable to load members"
          message="Check the connection and try again."
          onRetry={() => void peopleQuery.refetch()}
        />
      )}
      {peopleQuery.data && (
        <DataTable rows={rows} headers={headers} isSortable>
          {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => (
            <TableContainer>
              <TableToolbar aria-label="Members table toolbar">
                <TableToolbarContent>
                  <Search
                    id="people-search"
                    labelText="Search members"
                    placeholder="Search members"
                    value={searchValue}
                    onChange={(event) => setSearchValue(event.target.value)}
                  />
                  {mayCreate && (
                    <Button
                      kind="primary"
                      renderIcon={Add}
                      onClick={() => navigate('/settings/users/new')}
                    >
                      Add member
                    </Button>
                  )}
                </TableToolbarContent>
              </TableToolbar>
              <Table {...getTableProps()}>
                <TableHead>
                  <TableRow>
                    {tableHeaders.map((header) => (
                      <TableHeader {...getHeaderProps({ header })} key={header.key}>
                        {header.header}
                      </TableHeader>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {tableRows.map((row) => (
                    <TableRow {...getRowProps({ row })} key={row.id}>
                      {row.cells.map((cell, index) => (
                        <TableCell key={cell.id}>
                          {index === 0 ? (
                            <CarbonLink
                              href={`/settings/users/${row.id}`}
                              onClick={(event) => {
                                event.preventDefault();
                                navigate(`/settings/users/${row.id}`);
                              }}
                            >
                              {String(cell.value)}
                            </CarbonLink>
                          ) : cell.info.header === 'account' && cell.value !== 'No account' && cell.value !== 'Restricted' ? (
                            <Tag type={cell.value === 'enabled' ? 'green' : 'gray'}>
                              {String(cell.value)}
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
                  <h2>No members found</h2>
                  <p>{search ? 'Try a different search.' : 'No members have been added yet.'}</p>
                </div>
              )}
              <Pagination
                page={peopleQuery.data.page}
                pageSize={peopleQuery.data.pageSize}
                totalItems={peopleQuery.data.total}
                pageSizes={PAGE_SIZES}
                onChange={({ page: nextPage, pageSize: nextPageSize }) => {
                  const next = new URLSearchParams(searchParams);
                  next.set('page', String(nextPage));
                  next.set('pageSize', String(nextPageSize));
                  setSearchParams(next);
                }}
              />
            </TableContainer>
          )}
        </DataTable>
      )}
    </Stack>
  );
}
