import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  ComposedModal,
  DataTable,
  Dropdown,
  Form,
  InlineNotification,
  Link as CarbonLink,
  ModalBody,
  ModalFooter,
  ModalHeader,
  MultiSelect,
  Pagination,
  Stack,
  Table,
  TableBatchAction,
  TableBatchActions,
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
  Tag,
} from '@carbon/react';
import { Add, Filter, TrashCan, UserFollow, UserRole } from '@carbon/icons-react';
import { keepPreviousData, useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  createPersonAccount,
  deleteAccount,
} from '../../api/generated/accounts/accounts';
import type {
  LaborordnungStatus,
  PeopleAccountStatusFilter,
  PeopleLaborordnungStatusFilter,
  Person,
  Role,
} from '../../api/generated/models';
import {
  assignPersonRole,
  deletePerson,
  getPersonMakerspaceStatus,
} from '../../api/generated/people/people';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { canManageRoleMembership, hasPermission, PermissionId } from '../auth/permissions';
import { fullRoleCatalogOptions } from '../roles/queries';
import { peopleKeys, peopleListOptions } from './queries';
import { PersonAvatar } from './PersonAvatar';

const PAGE_SIZES = [10, 25, 50, 100];
const EMPTY_PEOPLE: Person[] = [];

type FilterOption<T extends string> = {
  value: T;
  label: string;
};

const ACCOUNT_STATUS_OPTIONS: Array<FilterOption<PeopleAccountStatusFilter>> = [
  { value: 'enabled', label: 'Active' },
  { value: 'disabled', label: 'Inactive' },
  { value: 'no_account', label: 'No account' },
];

const LAB_RULES_STATUS_OPTIONS: Array<FilterOption<PeopleLaborordnungStatusFilter>> = [
  { value: 'current', label: 'Current' },
  { value: 'pending', label: 'Confirmation pending' },
  { value: 'outdated', label: 'Acknowledgement outdated' },
  { value: 'no_published_version', label: 'No published version' },
  { value: 'not_required', label: 'Not required' },
];

type BatchAction =
  | 'create-accounts'
  | 'assign-role'
  | 'delete-accounts'
  | 'delete-people'
  | null;
type BatchResult = {
  kind: 'success' | 'warning';
  title: string;
  subtitle: string;
};

type LabRulesStatusPresentation = {
  label: string;
  type: 'gray' | 'green' | 'purple' | 'warm-gray';
};

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function peopleWithAccounts(people: Person[]): Person[] {
  return people.filter((person) => person.account && typeof person.account === 'object');
}

function formatLabRulesStatus(status?: LaborordnungStatus): LabRulesStatusPresentation {
  if (!status) return { label: 'Unavailable', type: 'gray' };
  if (status.requestId) return { label: 'Confirmation pending', type: 'purple' };
  if (status.state === 'current') return { label: 'Current', type: 'green' };
  if (status.state === 'outdated') {
    return {
      label: 'Acknowledgement outdated',
      type: status.actionRequired ? 'warm-gray' : 'gray',
    };
  }
  if (status.state === 'no_published_version') {
    return { label: 'No published version', type: 'gray' };
  }
  return { label: 'Not required', type: 'gray' };
}

function LabRulesStatusTag({
  status,
  pending,
  failed,
}: {
  status?: LaborordnungStatus;
  pending: boolean;
  failed: boolean;
}) {
  if (pending) return <span className="section-description">Loading…</span>;
  const presentation = formatLabRulesStatus(failed ? undefined : status);
  return <Tag type={presentation.type}>{presentation.label}</Tag>;
}

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
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [batchAction, setBatchAction] = useState<BatchAction>(null);
  const [batchMembers, setBatchMembers] = useState<Person[]>([]);
  const [batchRole, setBatchRole] = useState<Role | null>(null);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [tableKey, setTableKey] = useState(0);
  const mayCreate = hasPermission(currentUser, PermissionId.peoplecreate);
  const showAccounts = hasPermission(currentUser, PermissionId.accountsread);
  const mayReadRoles = hasPermission(currentUser, PermissionId.rolesread);
  const mayReadLabRules = hasPermission(
    currentUser,
    PermissionId.laborordnungrequestsread,
  );
  const mayViewSupervisorStaffing = hasPermission(
    currentUser,
    PermissionId.supervisor_dashboardread,
  );

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
  const mayCreateAccounts =
    showAccounts && hasPermission(currentUser, PermissionId.accountscreate);
  const mayAssignRoles =
    hasPermission(currentUser, PermissionId.peoplerolesassign) &&
    hasPermission(currentUser, PermissionId.rolesread);
  const hasDeleteAccountsPermission = hasPermission(
    currentUser,
    PermissionId.accountsdelete,
  );
  const mayDeleteAccounts = showAccounts && hasDeleteAccountsPermission;
  const mayDeletePeople = hasPermission(currentUser, PermissionId.peopledelete) &&
    (showAccounts || hasDeleteAccountsPermission);
  const canBatchManage =
    mayCreateAccounts || mayAssignRoles || mayDeleteAccounts || mayDeletePeople;
  const rolesQuery = useQuery({ ...fullRoleCatalogOptions, enabled: mayReadRoles });
  const supervisorRoleIds = useMemo(
    () => new Set((rolesQuery.data ?? []).filter((role) => role.supervisorDashboard).map((role) => role.id)),
    [rolesQuery.data],
  );
  const assignableRoles = useMemo(
    () =>
      (rolesQuery.data ?? []).filter((role) =>
        canManageRoleMembership(currentUser, role),
      ),
    [currentUser, rolesQuery.data],
  );

  const refreshPeople = async () => {
    await queryClient.invalidateQueries({ queryKey: peopleKeys.lists() });
    setTableKey((value) => value + 1);
  };
  const batchCreateAccounts = useMutation({
    mutationFn: async (members: Person[]) => {
      const eligible = members.filter((member) => member.account === null);
      const results = await Promise.allSettled(
        eligible.map((person) =>
          createPersonAccount(person.id, {
            expectedVersion: person.version,
          }),
        ),
      );
      return {
        created: results.filter((result) => result.status === 'fulfilled').length,
        failed: results.filter((result) => result.status === 'rejected').length,
        skipped: members.length - eligible.length,
      };
    },
    onSuccess: async ({ created, failed, skipped }) => {
      setBatchAction(null);
      setBatchMembers([]);
      setBatchResult({
        kind: failed === 0 ? 'success' : 'warning',
        title: failed === 0 ? 'Accounts created' : 'Some accounts were not created',
        subtitle: `${created} created${skipped ? `; ${skipped} skipped because an account already exists` : ''}${failed ? `; ${failed} could not be created` : ''}.`,
      });
      await refreshPeople();
    },
  });
  const batchAssignRole = useMutation({
    mutationFn: async ({ members, role }: { members: Person[]; role: Role }) => {
      const eligible = members.filter(
        (person) => !person.roles.some((assigned) => assigned.id === role.id),
      );
      const results = await Promise.allSettled(
        eligible.map((person) =>
          assignPersonRole(person.id, role.id, {
            expectedVersion: person.version,
          }),
        ),
      );
      return {
        assigned: results.filter((result) => result.status === 'fulfilled').length,
        failed: results.filter((result) => result.status === 'rejected').length,
        skipped: members.length - eligible.length,
      };
    },
    onSuccess: async ({ assigned, failed, skipped }) => {
      setBatchAction(null);
      setBatchMembers([]);
      setBatchRole(null);
      setBatchResult({
        kind: failed === 0 ? 'success' : 'warning',
        title: failed === 0 ? 'Roles assigned' : 'Some roles were not assigned',
        subtitle: `${assigned} assigned${skipped ? `; ${skipped} skipped because the role is already assigned` : ''}${failed ? `; ${failed} could not be assigned` : ''}.`,
      });
      await refreshPeople();
    },
  });
  const batchDeleteAccounts = useMutation({
    mutationFn: async (members: Person[]) => {
      const eligible = peopleWithAccounts(members);
      const results = await Promise.allSettled(
        eligible.map((person) =>
          deleteAccount(person.account!.id, {
            expectedVersion: person.account!.version,
          }),
        ),
      );
      return {
        deletedAccountIds: results.flatMap((result, index) =>
          result.status === 'fulfilled' ? [eligible[index].account!.id] : [],
        ),
        deleted: results.filter((result) => result.status === 'fulfilled').length,
        failed: results.filter((result) => result.status === 'rejected').length,
        skipped: members.length - eligible.length,
      };
    },
    onSuccess: async ({ deletedAccountIds, deleted, failed, skipped }) => {
      setBatchAction(null);
      setBatchMembers([]);
      for (const accountId of deletedAccountIds) {
        queryClient.removeQueries({ queryKey: ['accounts', 'detail', accountId] });
      }
      setBatchResult({
        kind: failed === 0 ? 'success' : 'warning',
        title: failed === 0
          ? 'Accounts deleted'
          : deleted === 0
            ? 'Accounts were not deleted'
            : 'Some accounts were not deleted',
        subtitle: `${deleted} deleted${skipped ? `; ${skipped} skipped because no visible account exists` : ''}${failed ? `; ${failed} could not be deleted` : ''}.`,
      });
      await refreshPeople();
    },
  });
  const peopleEligibleForDeletion = (members: Person[]) =>
    members.filter((member) => hasDeleteAccountsPermission || member.account === null);
  const batchDeletePeople = useMutation({
    mutationFn: async (members: Person[]) => {
      const eligible = peopleEligibleForDeletion(members);
      const results = await Promise.allSettled(
        eligible.map((person) =>
          deletePerson(person.id, {
            expectedVersion: person.version,
          }),
        ),
      );
      return {
        deletedPersonIds: results.flatMap((result, index) =>
          result.status === 'fulfilled' ? [eligible[index].id] : [],
        ),
        deleted: results.filter((result) => result.status === 'fulfilled').length,
        failed: results.filter((result) => result.status === 'rejected').length,
        skipped: members.length - eligible.length,
      };
    },
    onSuccess: async ({ deletedPersonIds, deleted, failed, skipped }) => {
      setBatchAction(null);
      setBatchMembers([]);
      for (const personId of deletedPersonIds) {
        queryClient.removeQueries({ queryKey: peopleKeys.detail(personId) });
      }
      setBatchResult({
        kind: failed === 0 ? 'success' : 'warning',
        title: failed === 0
          ? 'People deleted'
          : deleted === 0
            ? 'People were not deleted'
            : 'Some people were not deleted',
        subtitle: `${deleted} deleted${skipped ? `; ${skipped} skipped because deleting their account is not permitted` : ''}${failed ? `; ${failed} could not be deleted` : ''}.`,
      });
      await refreshPeople();
    },
  });

  const people = peopleQuery.data?.items ?? EMPTY_PEOPLE;
  const makerspaceStatusQueries = useQueries({
    queries: mayReadLabRules
      ? people.map((person) => ({
          queryKey: [...peopleKeys.detail(person.id), 'makerspace-status'],
          queryFn: ({ signal }: { signal: AbortSignal }) =>
            getPersonMakerspaceStatus(person.id, { signal }),
          staleTime: 30_000,
        }))
      : [],
  });
  const makerspaceStatusByPersonId = new Map(
    people.map((person, index) => [person.id, makerspaceStatusQueries[index]]),
  );
  const peopleById = useMemo(
    () => new Map(people.map((person) => [person.id, person])),
    [people],
  );
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
          labRules: formatLabRulesStatus(
            makerspaceStatusByPersonId.get(person.id)?.data?.laborordnungStatus,
          ).label,
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
                : person.account.status === 'enabled' ? 'Active' : 'Inactive',
        }
      : {}),
  }));
  const membersEligibleForAccountCreation = batchMembers.filter((member) => member.account === null);
  const membersEligibleForAccountDeletion = peopleWithAccounts(batchMembers);
  const membersEligibleForPersonDeletion = peopleEligibleForDeletion(batchMembers);
  const membersEligibleForRoleAssignment = batchRole
    ? batchMembers.filter(
        (member) => !member.roles.some((assigned) => assigned.id === batchRole.id),
      )
    : batchMembers;

  const selectedRoles = (rolesQuery.data ?? []).filter((role) =>
    selectedRoleIds.includes(role.id),
  );
  const canFilter = showAccounts || mayReadRoles || mayReadLabRules;
  const hasActiveFilters = (mayReadRoles && selectedRoleIds.length > 0)
    || (showAccounts && selectedAccountStatusOptions.length > 0)
    || (mayReadLabRules && selectedLabRulesStatusOptions.length > 0);

  const updateFilter = (key: 'role' | 'status' | 'labRules', values: string[]) => {
    const next = new URLSearchParams(searchParams);
    next.set('page', '1');
    next.delete(key);
    for (const value of values) next.append(key, value);
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
      title="Directory"
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
        <InlineNotification
          kind={batchResult.kind}
          lowContrast
          title={batchResult.title}
          subtitle={batchResult.subtitle}
          onCloseButtonClick={() => setBatchResult(null)}
        />
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
            const selectedForAccountCreation = selectedMembers.filter((member) => member.account === null);
            const selectedForRoleAssignment = selectedMembers;
            const selectedForAccountDeletion = peopleWithAccounts(selectedMembers);
            const selectedForPersonDeletion = peopleEligibleForDeletion(selectedMembers);

            return (
              <TableContainer className="people-table-container">
                <TableToolbar className="people-table-toolbar" aria-label="Directory table toolbar">
                  {canBatchManage && (
                    <TableBatchActions {...getBatchActionProps()}>
                      {mayCreateAccounts && (
                        <TableBatchAction
                          renderIcon={UserFollow}
                          iconDescription="Create login accounts"
                          disabled={selectedForAccountCreation.length === 0}
                          onClick={() => {
                            setBatchMembers(selectedMembers);
                            setBatchAction('create-accounts');
                          }}
                        >
                          Create accounts
                        </TableBatchAction>
                      )}
                      {mayAssignRoles && (
                        <TableBatchAction
                          renderIcon={UserRole}
                          iconDescription="Assign role"
                          disabled={
                            selectedForRoleAssignment.length === 0 ||
                            assignableRoles.length === 0
                          }
                          onClick={() => {
                            setBatchMembers(selectedMembers);
                            setBatchAction('assign-role');
                          }}
                        >
                          Assign role
                        </TableBatchAction>
                      )}
                      {mayDeleteAccounts && (
                        <TableBatchAction
                          renderIcon={TrashCan}
                          iconDescription="Delete login accounts"
                          disabled={selectedForAccountDeletion.length === 0}
                          onClick={() => {
                            setBatchMembers(selectedMembers);
                            setBatchAction('delete-accounts');
                          }}
                        >
                          Delete accounts
                        </TableBatchAction>
                      )}
                      {mayDeletePeople && (
                        <TableBatchAction
                          renderIcon={TrashCan}
                          iconDescription="Delete people"
                          disabled={selectedForPersonDeletion.length === 0}
                          onClick={() => {
                            setBatchMembers(selectedMembers);
                            setBatchAction('delete-people');
                          }}
                        >
                          Delete people
                        </TableBatchAction>
                      )}
                    </TableBatchActions>
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
                      <Button
                        hasIconOnly
                        kind={hasActiveFilters ? 'primary' : 'ghost'}
                        size="md"
                        renderIcon={Filter}
                        iconDescription="Filters"
                        aria-expanded={filtersOpen}
                        aria-controls="people-filters"
                        onClick={() => setFiltersOpen((open) => !open)}
                      />
                    )}
                    {mayCreate && (
                      <Button
                        kind="primary"
                        renderIcon={Add}
                        onClick={() => navigate('/people/new')}
                      >
                        Add person
                      </Button>
                    )}
                    {mayViewSupervisorStaffing && (
                      <Button
                        kind="tertiary"
                        renderIcon={UserRole}
                        onClick={() => navigate('/people/staffing')}
                      >
                        Members
                      </Button>
                    )}
                  </TableToolbarContent>
                </TableToolbar>
                {filtersOpen && (
                  <div id="people-filters" className="people-filter-panel" role="region" aria-label="Directory filters">
                    <div className="people-filter-panel__fields">
                      {mayReadRoles && (
                        <MultiSelect
                          id="people-role-filter"
                          className="people-filter-panel__field"
                          titleText="Role"
                          label={rolesQuery.isPending ? 'Loading roles…' : 'All roles'}
                          items={rolesQuery.data ?? []}
                          itemToString={(role) => role?.name ?? ''}
                          selectedItems={selectedRoles}
                          disabled={rolesQuery.isPending || rolesQuery.isError}
                          onChange={({ selectedItems }) => updateFilter('role', (selectedItems ?? []).map((role) => role.id))}
                        />
                      )}
                      {mayReadLabRules && (
                        <MultiSelect
                          id="people-lab-rules-filter"
                          className="people-filter-panel__field"
                          titleText="Lab Rules"
                          label="All Lab Rules statuses"
                          items={LAB_RULES_STATUS_OPTIONS}
                          itemToString={(option) => option?.label ?? ''}
                          selectedItems={selectedLabRulesStatusOptions}
                          onChange={({ selectedItems }) => updateFilter('labRules', (selectedItems ?? []).map((option) => option.value))}
                        />
                      )}
                      {showAccounts && (
                        <MultiSelect
                          id="people-account-status-filter"
                          className="people-filter-panel__field"
                          titleText="Status"
                          label="All account statuses"
                          items={ACCOUNT_STATUS_OPTIONS}
                          itemToString={(option) => option?.label ?? ''}
                          selectedItems={selectedAccountStatusOptions}
                          onChange={({ selectedItems }) => updateFilter('status', (selectedItems ?? []).map((option) => option.value))}
                        />
                      )}
                      <Button kind="ghost" size="md" disabled={!hasActiveFilters} onClick={clearFilters}>
                        Clear filters
                      </Button>
                    </div>
                  </div>
                )}
                <Table {...getTableProps()}>
                  <TableHead>
                    <TableRow>
                      {canBatchManage && <TableSelectAll {...getSelectionProps()} />}
                      {tableHeaders.map((header) => (
                        <TableHeader
                          {...getHeaderProps({ header, isSortable: header.key !== 'avatar' && header.key !== 'status' })}
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
                        {canBatchManage && (
                          <TableSelectRow {...getSelectionProps({ row })} />
                        )}
                        {row.cells.map((cell) => (
                          <TableCell
                            key={cell.id}
                            className={cell.info.header === 'avatar'
                              ? 'people-table__avatar-cell'
                              : cell.info.header === 'status'
                                ? 'people-table__status-column'
                                : undefined}
                          >
                            {cell.info.header === 'avatar' ? (() => {
                              const person = peopleById.get(row.id);
                              return person ? <PersonAvatar firstName={person.firstName} lastName={person.lastName} profileImage={person.profileImage} size="sm" decorative /> : null;
                            })() : cell.info.header === 'name' ? (
                              <CarbonLink
                                href={`/people/${row.id}`}
                                onClick={(event) => {
                                  event.preventDefault();
                                  navigate(`/people/${row.id}`);
                                }}
                              >
                                {String(cell.value)}
                              </CarbonLink>
                            ) : cell.info.header === 'status' &&
                              cell.value !== 'No account' &&
                              cell.value !== 'Restricted' ? (
                              <Tag type={cell.value === 'Active' ? 'green' : 'gray'}>
                                {String(cell.value)}
                              </Tag>
                            ) : cell.info.header === 'roles' ? (() => {
                              const person = peopleById.get(row.id);
                              if (!person || person.roles.length === 0) {
                                return String(cell.value);
                              }
                              return (
                                <div className="people-table__roles" aria-label={`Roles for ${person.firstName} ${person.lastName}`}>
                                  {person.roles.map((role) => {
                                    const isSupervisorRole = supervisorRoleIds.has(role.id);
                                    return (
                                      <Tag
                                        key={role.id}
                                        type={isSupervisorRole ? 'blue' : 'gray'}
                                        title={isSupervisorRole ? `${role.name} is a supervisor role` : role.name}
                                        aria-label={isSupervisorRole ? `${role.name}, supervisor role` : role.name}
                                      >
                                        {role.name}
                                      </Tag>
                                    );
                                  })}
                                </div>
                              );
                            })() : cell.info.header === 'labRules' ? (
                              <LabRulesStatusTag
                                status={makerspaceStatusByPersonId.get(row.id)?.data?.laborordnungStatus}
                                pending={makerspaceStatusByPersonId.get(row.id)?.isPending ?? false}
                                failed={makerspaceStatusByPersonId.get(row.id)?.isError ?? false}
                              />
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
                    <h2>No people found</h2>
                    <p>{search || hasActiveFilters ? 'Try different search terms or filters.' : 'No people have been added yet.'}</p>
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

      <ComposedModal
        open={batchAction === 'create-accounts'}
        onClose={() => setBatchAction(null)}
      >
        <ModalHeader title="Create login accounts" />
        <ModalBody>
          <Stack gap={5}>
            <p>
              This creates active accounts for {membersEligibleForAccountCreation.length}{' '}
              selected {membersEligibleForAccountCreation.length === 1 ? 'person' : 'people'}.
              Authentication methods can be configured separately afterwards; without one, the person cannot sign in.
            </p>
            {batchMembers.length !== membersEligibleForAccountCreation.length && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Some people will be skipped"
                subtitle="People who already have an account are not changed."
              />
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={() => setBatchAction(null)}>
            Cancel
          </Button>
          <Button
            disabled={
              membersEligibleForAccountCreation.length === 0 || batchCreateAccounts.isPending
            }
            onClick={() => batchCreateAccounts.mutate(batchMembers)}
          >
            {batchCreateAccounts.isPending ? 'Creating…' : 'Create accounts'}
          </Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal
        open={batchAction === 'assign-role'}
        onClose={() => setBatchAction(null)}
      >
        <ModalHeader title="Assign role to people" />
        <ModalBody>
          <Form>
            <Stack gap={5}>
              <Dropdown
                id="batch-assign-role"
                titleText="Role"
                label="Choose a role"
                items={assignableRoles}
                itemToString={(role) => role?.name ?? ''}
                selectedItem={batchRole}
                onChange={({ selectedItem }) => setBatchRole(selectedItem ?? null)}
              />
              <p>
                The selected role will be assigned to {membersEligibleForRoleAssignment.length}{' '}
                {membersEligibleForRoleAssignment.length === 1 ? 'person' : 'people'}.
              </p>
              {batchMembers.length !== membersEligibleForRoleAssignment.length && (
                <InlineNotification
                  kind="info"
                  lowContrast
                  hideCloseButton
                  title="Some people will be skipped"
                  subtitle="People who already have the role are not changed."
                />
              )}
            </Stack>
          </Form>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" onClick={() => setBatchAction(null)}>
            Cancel
          </Button>
          <Button
            disabled={
              !batchRole ||
              membersEligibleForRoleAssignment.length === 0 ||
              batchAssignRole.isPending
            }
            onClick={() =>
              batchRole && batchAssignRole.mutate({ members: batchMembers, role: batchRole })
            }
          >
            {batchAssignRole.isPending ? 'Assigning…' : 'Assign role'}
          </Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal
        aria-label="Delete accounts permanently?"
        danger
        open={batchAction === 'delete-accounts'}
        onClose={() => {
          if (!batchDeleteAccounts.isPending) setBatchAction(null);
        }}
      >
        <ModalHeader title="Delete accounts permanently?" />
        <ModalBody>
          <Stack gap={5}>
            <p>
              This permanently deletes {membersEligibleForAccountDeletion.length}{' '}
              selected {membersEligibleForAccountDeletion.length === 1 ? 'account' : 'accounts'},
              including their authentication methods and role assignments. The people records
              remain. This cannot be undone.
            </p>
            {batchMembers.some((member) => member.id === currentUser.person.id && member.account) && (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title="Your own account is selected"
                subtitle="Deleting it will end your access to the application."
              />
            )}
            {batchMembers.length !== membersEligibleForAccountDeletion.length && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Some people will be skipped"
                subtitle="A visible account is required."
              />
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button
            kind="secondary"
            disabled={batchDeleteAccounts.isPending}
            onClick={() => setBatchAction(null)}
          >
            Cancel
          </Button>
          <Button
            kind="danger"
            disabled={
              membersEligibleForAccountDeletion.length === 0 ||
              batchDeleteAccounts.isPending
            }
            onClick={() => batchDeleteAccounts.mutate(batchMembers)}
          >
            {batchDeleteAccounts.isPending ? 'Deleting…' : 'Delete accounts'}
          </Button>
        </ModalFooter>
      </ComposedModal>

      <ComposedModal
        aria-label="Delete people permanently?"
        danger
        open={batchAction === 'delete-people'}
        onClose={() => {
          if (!batchDeletePeople.isPending) setBatchAction(null);
        }}
      >
        <ModalHeader title="Delete people permanently?" />
        <ModalBody>
          <Stack gap={5}>
            <p>
              This permanently deletes {membersEligibleForPersonDeletion.length}{' '}
              selected {membersEligibleForPersonDeletion.length === 1 ? 'person' : 'people'},
              including their accounts, authentication methods, and role assignments. This cannot
              be undone.
            </p>
            {membersEligibleForPersonDeletion.some(
              (member) => member.id === currentUser.person.id,
            ) && (
              <InlineNotification
                kind="warning"
                lowContrast
                hideCloseButton
                title="Your own person record is selected"
                subtitle="Deleting it will end your access to the application."
              />
            )}
            {batchMembers.length !== membersEligibleForPersonDeletion.length && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Some people will be skipped"
                subtitle="Deleting a person with an account requires permission to delete accounts."
              />
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button
            kind="secondary"
            disabled={batchDeletePeople.isPending}
            onClick={() => setBatchAction(null)}
          >
            Cancel
          </Button>
          <Button
            kind="danger"
            disabled={
              membersEligibleForPersonDeletion.length === 0 ||
              batchDeletePeople.isPending
            }
            onClick={() => batchDeletePeople.mutate(batchMembers)}
          >
            {batchDeletePeople.isPending ? 'Deleting…' : 'Delete people'}
          </Button>
        </ModalFooter>
      </ComposedModal>
    </PageShell>
  );
}
