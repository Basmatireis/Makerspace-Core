import { useEffect, useState } from 'react';
import {
  Accordion,
  AccordionItem,
  Button,
  DataTable,
  InlineNotification,
  ListItem,
  UnorderedList,
  Pagination,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  TableSelectAll,
  TableSelectRow,
  TableToolbar,
  TableToolbarContent,
  TableToolbarSearch,
} from '@carbon/react';
import { Add, UserRole } from '@carbon/icons-react';
import { keepPreviousData, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { Person } from '../../api/generated/models';
import { getPersonMakerspaceStatus } from '../../api/generated/people/people';
import { BatchFilter, type FilterCategory, type FilterValues } from '../../app/BatchFilter';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { canManageRoleMembership, hasPermission, PermissionId } from '../auth/permissions';
import { fullRoleCatalogOptions } from '../roles/queries';
import { BatchPeopleDialogs } from './people/BatchPeopleDialogs';
import { PeopleBatchActions } from './people/PeopleBatchActions';
import { PeopleCell } from './people/PeopleCell';
import {
  ACCOUNT_STATUS_OPTIONS,
  EMPTY_PEOPLE,
  formatLabRulesStatus,
  LAB_RULES_STATUS_OPTIONS,
  PAGE_SIZES,
  positiveInteger,
} from './people/peopleList';
import { useBatchPeopleActions } from './people/useBatchPeopleActions';
import { peopleKeys, peopleListOptions } from './queries';

export function UsersPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = positiveInteger(searchParams.get('page'), 1);
  const pageSize = Math.min(100, positiveInteger(searchParams.get('pageSize'), 25));
  const search = searchParams.get('search') ?? '';
  const selectedRoleIds = searchParams.getAll('role');
  const selectedAccountStatusOptions = ACCOUNT_STATUS_OPTIONS.filter((option) =>
    searchParams.getAll('status').includes(option.value),
  );
  const selectedLabRulesStatusOptions = LAB_RULES_STATUS_OPTIONS.filter((option) =>
    searchParams.getAll('labRules').includes(option.value),
  );
  const [searchValue, setSearchValue] = useState(search);
  const [tableKey, setTableKey] = useState(0);
  const mayCreate = hasPermission(currentUser, PermissionId.peoplecreate);
  const showAccounts = hasPermission(currentUser, PermissionId.accountsread);
  const mayReadRoles = hasPermission(currentUser, PermissionId.rolesread);
  const mayReadLabRules = hasPermission(currentUser, PermissionId.laborordnungrequestsread);
  const mayViewSupervisorStaffing = hasPermission(currentUser, PermissionId.supervisor_dashboardread);

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

  const peopleQuery = useQuery({
    ...peopleListOptions({
      page,
      pageSize,
      ...(search ? { search } : {}),
      ...(mayReadRoles && selectedRoleIds.length ? { roleIds: selectedRoleIds } : {}),
      ...(showAccounts && selectedAccountStatusOptions.length
        ? { accountStatuses: selectedAccountStatusOptions.map((option) => option.value) }
        : {}),
      ...(mayReadLabRules && selectedLabRulesStatusOptions.length
        ? { laborordnungStatuses: selectedLabRulesStatusOptions.map((option) => option.value) }
        : {}),
    }),
    placeholderData: keepPreviousData,
  });
  const mayCreateAccounts = showAccounts && hasPermission(currentUser, PermissionId.accountscreate);
  const mayAssignRoles =
    hasPermission(currentUser, PermissionId.peoplerolesassign) && hasPermission(currentUser, PermissionId.rolesread);
  const hasDeleteAccountsPermission = hasPermission(currentUser, PermissionId.accountsdelete);
  const mayDeleteAccounts = showAccounts && hasDeleteAccountsPermission;
  const mayDeletePeople =
    hasPermission(currentUser, PermissionId.peopledelete) && (showAccounts || hasDeleteAccountsPermission);
  const mayMerge = hasPermission(currentUser, PermissionId.peoplemerge);
  const canBatchManage = mayCreateAccounts || mayAssignRoles || mayDeleteAccounts || mayDeletePeople || mayMerge;
  const rolesQuery = useQuery({ ...fullRoleCatalogOptions, enabled: mayReadRoles });
  const supervisorRoleIds = new Set(
    (rolesQuery.data ?? []).filter((role) => role.staffingLevel === 'supervisor').map((role) => role.id),
  );
  const assignableRoles = (rolesQuery.data ?? []).filter((role) => canManageRoleMembership(currentUser, role));
  const refreshPeople = async () => {
    await queryClient.invalidateQueries({ queryKey: peopleKeys.lists() });
    setTableKey((value) => value + 1);
  };
  const batch = useBatchPeopleActions({ canDeleteAccounts: hasDeleteAccountsPermission, onChanged: refreshPeople });
  const { batchResult, setBatchResult } = batch;

  const people = peopleQuery.data?.items ?? EMPTY_PEOPLE;
  const makerspaceStatusQueries = useQueries({
    queries: mayReadLabRules
      ? people.map((person) => ({
          queryKey: [...peopleKeys.detail(person.id), 'makerspace-status'],
          queryFn: ({ signal }: { signal: AbortSignal }) => getPersonMakerspaceStatus(person.id, { signal }),
          staleTime: 30_000,
        }))
      : [],
  });
  const makerspaceStatusByPersonId = new Map(
    people.map((person, index) => [person.id, makerspaceStatusQueries[index]]),
  );
  const peopleById = new Map(people.map((person) => [person.id, person]));
  const headers = [
    { key: 'avatar', header: 'Profile' },
    { key: 'name', header: 'Name' },
    { key: 'contact', header: 'Contact' },
    { key: 'roles', header: 'Roles' },
    ...(mayReadLabRules ? [{ key: 'labRules', header: 'Lab Rules' }] : []),
    ...(showAccounts ? [{ key: 'status', header: 'Status' }] : []),
  ];
  const rows = people.map((person) => ({
    id: person.id,
    avatar: person.id,
    name: `${person.firstName} ${person.lastName}`,
    contact: person.email ?? person.phone ?? 'Not provided',
    ...(mayReadLabRules
      ? {
          labRules: formatLabRulesStatus(makerspaceStatusByPersonId.get(person.id)?.data?.laborordnungStatus).label,
        }
      : {}),
    roles: person.roles.length === 0 ? '—' : person.roles.map((role) => role.name).join(', '),
    ...(showAccounts
      ? {
          status:
            person.account === undefined
              ? 'Restricted'
              : person.account === null
                ? 'No account'
                : person.account.status === 'enabled'
                  ? 'Active'
                  : 'Inactive',
        }
      : {}),
  }));

  const canFilter = showAccounts || mayReadRoles || mayReadLabRules;
  const hasActiveFilters =
    (mayReadRoles && selectedRoleIds.length > 0) ||
    (showAccounts && selectedAccountStatusOptions.length > 0) ||
    (mayReadLabRules && selectedLabRulesStatusOptions.length > 0);
  const filterCategories: FilterCategory[] = [
    ...(mayReadRoles
      ? [
          {
            key: 'role',
            label: 'Role',
            options: (rolesQuery.data ?? []).map((role) => ({ id: role.id, label: role.name })),
            helperText: rolesQuery.isPending
              ? 'Loading roles…'
              : rolesQuery.isError
                ? 'Roles could not be loaded.'
                : undefined,
          },
        ]
      : []),
    ...(mayReadLabRules
      ? [
          {
            key: 'labRules',
            label: 'Lab Rules',
            options: LAB_RULES_STATUS_OPTIONS.map((option) => ({ id: option.value, label: option.label })),
          },
        ]
      : []),
    ...(showAccounts
      ? [
          {
            key: 'status',
            label: 'Status',
            options: ACCOUNT_STATUS_OPTIONS.map((option) => ({ id: option.value, label: option.label })),
          },
        ]
      : []),
  ];
  const appliedFilters: FilterValues = {
    role: selectedRoleIds,
    labRules: selectedLabRulesStatusOptions.map((option) => option.value),
    status: selectedAccountStatusOptions.map((option) => option.value),
  };

  const applyFilters = (values: FilterValues) => {
    const next = new URLSearchParams(searchParams);
    next.set('page', '1');
    for (const category of filterCategories) {
      next.delete(category.key);
      for (const value of values[category.key] ?? []) next.append(category.key, value);
    }
    setSearchParams(next, { replace: true });
  };

  const clearFilters = () => {
    const next = new URLSearchParams(searchParams);
    next.set('page', '1');
    next.delete('role');
    next.delete('status');
    next.delete('labRules');
    setSearchParams(next, { replace: true });
  };

  return (
    <PageShell
      title="People"
      breadcrumbs={[{ label: 'Directory' }, { label: 'People' }]}
      description="Manage people, login accounts, roles, and access."
      width="wide"
    >
      {peopleQuery.isPending && <InlineLoadingState label="Loading people" />}
      {peopleQuery.isError && (
        <ErrorState
          title="Unable to load people"
          message="Check the connection and try again."
          onRetry={() => void peopleQuery.refetch()}
        />
      )}
      {batchResult && (
        <Stack gap={3}>
          <InlineNotification
            kind={batchResult.kind}
            lowContrast
            title={batchResult.title}
            subtitle={batchResult.subtitle}
            onCloseButtonClick={() => setBatchResult(null)}
          />
          {Boolean(batchResult.failures?.length) && (
            <Accordion isFlush size="sm" aria-label="Failed deletions">
              {batchResult.failures!.map((failure, index) => (
                <AccordionItem
                  key={`${failure.name}-${index}`}
                  title={
                    failure.reasons.length === 1
                      ? `${failure.name} — ${failure.reasons[0]}`
                      : `${failure.name} — ${failure.reasons.length} reasons`
                  }
                >
                  <UnorderedList>
                    {failure.reasons.map((reason) => (
                      <ListItem key={reason}>{reason}</ListItem>
                    ))}
                  </UnorderedList>
                </AccordionItem>
              ))}
            </Accordion>
          )}
        </Stack>
      )}
      {peopleQuery.data && (
        <DataTable key={tableKey} rows={rows} headers={headers} isSortable>
          {({
            rows: tableRows,
            headers: tableHeaders,
            selectedRows,
            getBatchActionProps,
            getHeaderProps,
            getRowProps,
            getSelectionProps,
            getTableProps,
          }) => {
            const selectedMembers = selectedRows
              .map((row) => peopleById.get(row.id))
              .filter((person): person is Person => Boolean(person));

            return (
              <TableContainer className="people-table-container">
                <TableToolbar className="people-table-toolbar" aria-label="People table toolbar">
                  {canBatchManage && (
                    <PeopleBatchActions
                      batchActionProps={getBatchActionProps()}
                      selectedMembers={selectedMembers}
                      can={{
                        createAccounts: mayCreateAccounts,
                        assignRoles: mayAssignRoles,
                        deleteAccounts: mayDeleteAccounts,
                        deletePeople: mayDeletePeople,
                        merge: mayMerge,
                      }}
                      canDeleteAccounts={hasDeleteAccountsPermission}
                      hasAssignableRoles={assignableRoles.length > 0}
                      batch={batch}
                    />
                  )}
                  <TableToolbarContent>
                    <TableToolbarSearch
                      id="people-search"
                      labelText="Search people"
                      placeholder="Search people"
                      defaultValue={search}
                      onChange={(_event, value) => setSearchValue(value ?? '')}
                      onClear={() => setSearchValue('')}
                    />
                    {canFilter && (
                      <BatchFilter
                        id="people"
                        label="People"
                        categories={filterCategories}
                        applied={appliedFilters}
                        onApply={applyFilters}
                        onReset={clearFilters}
                      />
                    )}
                    {mayCreate && (
                      <Button kind="primary" renderIcon={Add} onClick={() => navigate('/people/new')}>
                        Add person
                      </Button>
                    )}
                    {mayViewSupervisorStaffing && (
                      <Button kind="tertiary" renderIcon={UserRole} onClick={() => navigate('/people/staffing')}>
                        Members
                      </Button>
                    )}
                  </TableToolbarContent>
                </TableToolbar>
                <Table {...getTableProps()}>
                  <TableHead>
                    <TableRow>
                      {canBatchManage && <TableSelectAll {...getSelectionProps()} />}
                      {tableHeaders.map((header) => (
                        <TableHeader
                          {...getHeaderProps({
                            header,
                            isSortable: header.key !== 'avatar' && header.key !== 'status',
                          })}
                          key={header.key}
                          className={header.key === 'status' ? 'people-table__status-column' : undefined}
                        >
                          {header.header}
                        </TableHeader>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {tableRows.map((row) => (
                      <TableRow {...getRowProps({ row })} key={row.id}>
                        {canBatchManage && <TableSelectRow {...getSelectionProps({ row })} />}
                        {row.cells.map((cell) => (
                          <TableCell
                            key={cell.id}
                            className={
                              cell.info.header === 'avatar'
                                ? 'people-table__avatar-cell'
                                : cell.info.header === 'status'
                                  ? 'people-table__status-column'
                                  : undefined
                            }
                          >
                            <PeopleCell
                              column={cell.info.header}
                              value={cell.value}
                              rowId={row.id}
                              person={peopleById.get(row.id)}
                              supervisorRoleIds={supervisorRoleIds}
                              labRules={{
                                status: makerspaceStatusByPersonId.get(row.id)?.data?.laborordnungStatus,
                                pending: makerspaceStatusByPersonId.get(row.id)?.isPending ?? false,
                                failed: makerspaceStatusByPersonId.get(row.id)?.isError ?? false,
                              }}
                              onOpenPerson={(personId) => navigate(`/people/${personId}`)}
                            />
                          </TableCell>
                        ))}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {rows.length === 0 && (
                  <div className="empty-state">
                    <h2>No people found</h2>
                    <p>
                      {search || hasActiveFilters
                        ? 'Try different search terms or filters.'
                        : 'No people have been added yet.'}
                    </p>
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
            );
          }}
        </DataTable>
      )}

      <BatchPeopleDialogs
        batch={batch}
        assignableRoles={assignableRoles}
        currentPersonId={currentUser.person.id}
        canDeleteAccounts={hasDeleteAccountsPermission}
      />
    </PageShell>
  );
}
