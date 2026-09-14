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

const PAGE_SIZES = [10, 25, 50, 100];
const EMPTY_MEMBERS: Person[] = [];

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

function accountMembers(members: Person[]): Person[] {
  return members.filter((member) => member.account && typeof member.account === 'object');
}

export function UsersPage() {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = positiveInteger(searchParams.get('page'), 1);
  const pageSize = Math.min(100, positiveInteger(searchParams.get('pageSize'), 25));
  const search = searchParams.get('search') ?? '';
  const [searchValue, setSearchValue] = useState(search);
  const [batchAction, setBatchAction] = useState<BatchAction>(null);
  const [batchMembers, setBatchMembers] = useState<Person[]>([]);
  const [batchRole, setBatchRole] = useState<Role | null>(null);
  const [batchResult, setBatchResult] = useState<BatchResult | null>(null);
  const [tableKey, setTableKey] = useState(0);

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
    ...peopleListOptions({ page, pageSize, ...(search ? { search } : {}) }),
    placeholderData: keepPreviousData,
  });
  const mayCreate = hasPermission(currentUser, PermissionId.peoplecreate);
  const showMatriculation = hasPermission(
    currentUser,
    PermissionId.peoplereadmatriculation,
  );
  const showAccounts = hasPermission(currentUser, PermissionId.accountsread);
  const mayCreateAccounts =
    showAccounts && hasPermission(currentUser, PermissionId.accountscreate);
  const mayAssignRoles =
    showAccounts &&
    hasPermission(currentUser, PermissionId.accountsrolesassign) &&
    hasPermission(currentUser, PermissionId.rolesread);
  const canBatchManage = mayCreateAccounts || mayAssignRoles;
  const rolesQuery = useQuery({ ...fullRoleCatalogOptions, enabled: mayAssignRoles });
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
        eligible.map((member) =>
          createPersonAccount(member.id, {
            loginEmail: member.email!,
            expectedVersion: member.version,
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
      const eligible = accountMembers(members).filter(
        (member) => !member.account!.roles.some((assigned) => assigned.id === role.id),
      );
      const results = await Promise.allSettled(
        eligible.map((member) =>
          assignAccountRole(member.account!.id, role.id, {
            expectedVersion: member.account!.version,
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

  const members = peopleQuery.data?.items ?? EMPTY_MEMBERS;
  const membersById = useMemo(
    () => new Map(members.map((member) => [member.id, member])),
    [members],
  );
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
  const rows = members.map((member) => ({
    id: member.id,
    name: `${member.firstName} ${member.lastName}`,
    contact: member.email ?? member.phone ?? 'Not provided',
    ...(showMatriculation
      ? { matriculationNumber: member.matriculationNumber ?? 'Not provided' }
      : {}),
    ...(showAccounts
      ? {
          account:
            member.account === undefined
              ? 'Restricted'
              : member.account === null
                ? 'No account'
                : member.account.status,
          roles:
            member.account === undefined
              ? 'Restricted'
              : member.account === null || member.account.roles.length === 0
                ? '—'
                : member.account.roles.map((role) => role.name).join(', '),
        }
      : {}),
  }));
  const membersEligibleForAccountCreation = batchMembers.filter(
    (member) => member.account === null && Boolean(member.email),
  );
  const membersEligibleForRoleAssignment = batchRole
    ? accountMembers(batchMembers).filter(
        (member) =>
          !member.account!.roles.some((assigned) => assigned.id === batchRole.id),
      )
    : accountMembers(batchMembers);

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
              .map((row) => membersById.get(row.id))
              .filter((member): member is Person => Boolean(member));
            const selectedForAccountCreation = selectedMembers.filter(
              (member) => member.account === null && Boolean(member.email),
            );
            const selectedForRoleAssignment = accountMembers(selectedMembers);

            return (
              <TableContainer>
                <TableToolbar aria-label="Members table toolbar">
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
                      labelText="Search members"
                      placeholder="Search members"
                      defaultValue={search}
                      onChange={(_event, value) => setSearchValue(value ?? '')}
                      onClear={() => setSearchValue('')}
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
                      {canBatchManage && <TableSelectAll {...getSelectionProps()} />}
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
                        {canBatchManage && (
                          <TableSelectRow {...getSelectionProps({ row })} />
                        )}
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
                            ) : cell.info.header === 'account' &&
                              cell.value !== 'No account' &&
                              cell.value !== 'Restricted' ? (
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
              selected {membersEligibleForAccountCreation.length === 1 ? 'member' : 'members'}.
              Each account uses the member’s existing email address as its login email.
            </p>
            {batchMembers.length !== membersEligibleForAccountCreation.length && (
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Some members will be skipped"
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
        <ModalHeader title="Assign role to members" />
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
                  title="Some members will be skipped"
                  subtitle="An account is required, and members who already have the role are not changed."
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
