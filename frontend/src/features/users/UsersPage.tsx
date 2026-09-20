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
import { Add, UserFollow, UserRole } from '@carbon/icons-react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { assignAccountRole, createPersonAccount } from '../../api/generated/accounts/accounts';
import type { Person, Role } from '../../api/generated/models';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { canManageRoleMembership, hasPermission, PermissionId } from '../auth/permissions';
import { fullRoleCatalogOptions } from '../roles/queries';
import { peopleKeys, peopleListOptions } from './queries';
import { PersonAvatar } from './PersonAvatar';

const PAGE_SIZES = [10, 25, 50, 100];
const EMPTY_PEOPLE: Person[] = [];

type BatchAction = 'create-accounts' | 'assign-role' | null;
type BatchResult = {
  kind: 'success' | 'warning';
  title: string;
  subtitle: string;
};

function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function peopleWithAccounts(people: Person[]): Person[] {
  return people.filter((person) => person.account && typeof person.account === 'object');
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
  const [searchValue, setSearchValue] = useState(search);
  const [batchAction, setBatchAction] = useState<BatchAction>(null);
  const [batchMembers, setBatchMembers] = useState<Person[]>([]);
  const [batchRole, setBatchRole] = useState<Role | null>(null);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [tableKey, setTableKey] = useState(0);
  const mayCreate = hasPermission(currentUser, PermissionId.peoplecreate);
  const showMatriculation = hasPermission(
    currentUser,
    PermissionId.peoplereadmatriculation,
  );
  const showAccounts = hasPermission(currentUser, PermissionId.accountsread);
  const mayReadRoles = hasPermission(currentUser, PermissionId.rolesread);
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
      ...(showAccounts && selectedRoleIds.length ? { roleIds: selectedRoleIds } : {}),
    }),
    placeholderData: keepPreviousData,
  });
  const mayCreateAccounts =
    showAccounts && hasPermission(currentUser, PermissionId.accountscreate);
  const mayAssignRoles =
    showAccounts &&
    hasPermission(currentUser, PermissionId.accountsrolesassign) &&
    hasPermission(currentUser, PermissionId.rolesread);
  const canBatchManage = mayCreateAccounts || mayAssignRoles;
  const rolesQuery = useQuery({ ...fullRoleCatalogOptions, enabled: showAccounts && mayReadRoles });
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
      const eligible = members.filter(
        (member) => member.account === null && Boolean(member.email),
      );
      const results = await Promise.allSettled(
        eligible.map((person) =>
          createPersonAccount(person.id, {
            loginEmail: person.email!,
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
        subtitle: `${created} created${skipped ? `; ${skipped} skipped because an account or email is missing` : ''}${failed ? `; ${failed} could not be created` : ''}.`,
      });
      await refreshPeople();
    },
  });
  const batchAssignRole = useMutation({
    mutationFn: async ({ members, role }: { members: Person[]; role: Role }) => {
      const eligible = peopleWithAccounts(members).filter(
        (person) => !person.account!.roles.some((assigned) => assigned.id === role.id),
      );
      const results = await Promise.allSettled(
        eligible.map((person) =>
          assignAccountRole(person.account!.id, role.id, {
            expectedVersion: person.account!.version,
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
        subtitle: `${assigned} assigned${skipped ? `; ${skipped} skipped because no account exists or the role is already assigned` : ''}${failed ? `; ${failed} could not be assigned` : ''}.`,
      });
      await refreshPeople();
    },
  });

  const people = peopleQuery.data?.items ?? EMPTY_PEOPLE;
  const peopleById = useMemo(
    () => new Map(people.map((person) => [person.id, person])),
    [people],
  );
  const headers = [
    { key: 'avatar', header: 'Profile' },
    { key: 'name', header: 'Name' },
    { key: 'contact', header: 'Contact' },
    ...(showMatriculation
      ? [{ key: 'matriculationNumber', header: 'Matriculation number' }]
      : []),
    ...(showAccounts
      ? [
          { key: 'account', header: 'Account' },
          { key: 'roles', header: 'Roles' },
          ...(mayReadRoles ? [{ key: 'supervisor', header: 'Supervisor' }] : []),
        ]
      : []),
  ];
  const rows = people.map((person) => ({
    id: person.id,
    avatar: person.id,
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
          ...(mayReadRoles
            ? {
                supervisor:
                  person.account && person.account.roles.some((role) => supervisorRoleIds.has(role.id))
                    ? 'Yes'
                    : '—',
              }
            : {}),
        }
      : {}),
  }));
  const membersEligibleForAccountCreation = batchMembers.filter(
    (member) => member.account === null && Boolean(member.email),
  );
  const membersEligibleForRoleAssignment = batchRole
    ? peopleWithAccounts(batchMembers).filter(
        (member) =>
          !member.account!.roles.some((assigned) => assigned.id === batchRole.id),
      )
    : peopleWithAccounts(batchMembers);

  const selectedRoles = (rolesQuery.data ?? []).filter((role) =>
    selectedRoleIds.includes(role.id),
  );

  const updateRoleFilter = (roles: Role[]) => {
    const next = new URLSearchParams(searchParams);
    next.set('page', '1');
    next.delete('role');
    for (const role of roles) next.append('role', role.id);
    setSearchParams(next, { replace: true });
  };

  return (
    <Stack gap={7}>
      <PageHeader
        title="People"
        breadcrumbs={[{ label: 'Settings', to: '/settings' }, { label: 'People' }]}
        description="Manage people, login accounts, roles, and access."
        actions={mayViewSupervisorStaffing ? (
          <Button kind="tertiary" onClick={() => navigate('/settings/users/staffing')}>
            Supervisor staffing
          </Button>
        ) : undefined}
      />

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
            const selectedForAccountCreation = selectedMembers.filter(
              (member) => member.account === null && Boolean(member.email),
            );
            const selectedForRoleAssignment = peopleWithAccounts(selectedMembers);

            return (
              <TableContainer className="people-table-container">
                <TableToolbar className="people-table-toolbar" aria-label="People table toolbar">
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
                    {showAccounts && mayReadRoles && (
                      <MultiSelect
                        id="people-role-filter"
                        className="people-role-filter"
                        titleText="Filter by role"
                        hideLabel
                        label={rolesQuery.isPending ? 'Loading roles…' : 'Filter by role'}
                        items={rolesQuery.data ?? []}
                        itemToString={(role) => role?.name ?? ''}
                        selectedItems={selectedRoles}
                        disabled={rolesQuery.isPending || rolesQuery.isError}
                        onChange={({ selectedItems }) => updateRoleFilter(selectedItems ?? [])}
                      />
                    )}
                    {mayCreate && (
                      <Button
                        kind="primary"
                        renderIcon={Add}
                        onClick={() => navigate('/settings/users/new')}
                      >
                        Add person
                      </Button>
                    )}
                  </TableToolbarContent>
                </TableToolbar>
                <Table {...getTableProps()}>
                  <TableHead>
                    <TableRow>
                      {canBatchManage && <TableSelectAll {...getSelectionProps()} />}
                      {tableHeaders.map((header) => (
                        <TableHeader {...getHeaderProps({ header, isSortable: header.key !== 'avatar' })} key={header.key}>
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
                          <TableCell key={cell.id} className={cell.info.header === 'avatar' ? 'people-table__avatar-cell' : undefined}>
                            {cell.info.header === 'avatar' ? (() => {
                              const person = peopleById.get(row.id);
                              return person ? <PersonAvatar firstName={person.firstName} lastName={person.lastName} profileImage={person.profileImage} size="sm" decorative /> : null;
                            })() : cell.info.header === 'name' ? (
                              <CarbonLink
                                href={`/settings/users/${row.id}`}
                                onClick={(event) => {
                                  event.preventDefault();
                                  navigate(`/settings/users/${row.id}`);
                                }}
                              >
                                {String(cell.value)}
                              </CarbonLink>
                            ) : cell.info.header === 'account' &&
                              cell.value !== 'No account' &&
                              cell.value !== 'Restricted' ? (
                              <Tag type={cell.value === 'enabled' ? 'green' : 'gray'}>
                                {String(cell.value)}
                              </Tag>
                            ) : cell.info.header === 'supervisor' && cell.value === 'Yes' ? (
                              <Tag type="blue">Supervisor</Tag>
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
                    <p>{search || selectedRoleIds.length ? 'Try different search terms or role filters.' : 'No people have been added yet.'}</p>
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
              This creates disabled login accounts for {membersEligibleForAccountCreation.length}{' '}
              selected {membersEligibleForAccountCreation.length === 1 ? 'person' : 'people'}.
              Each account uses the person’s existing email address as its login email.
            </p>
            {batchMembers.length !== membersEligibleForAccountCreation.length && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Some people will be skipped"
                subtitle="An existing account or an email address is required."
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
                {membersEligibleForRoleAssignment.length === 1 ? 'account' : 'accounts'}.
              </p>
              {batchMembers.length !== membersEligibleForRoleAssignment.length && (
                <InlineNotification
                  kind="info"
                  lowContrast
                  hideCloseButton
                  title="Some people will be skipped"
                  subtitle="An account is required, and people who already have the role are not changed."
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
    </Stack>
  );
}
