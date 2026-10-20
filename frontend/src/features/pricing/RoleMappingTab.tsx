import { useState } from 'react';
import {
  Button,
  IconButton,
  InlineNotification,
  Select,
  SelectItem,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
} from '@carbon/react';
import { ArrowDown, ArrowUp } from '@carbon/icons-react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { listRoles } from '../../api/generated/roles/roles';
import { setRolePricingGroups, updatePricingGroup } from '../../api/generated/pricing/pricing';
import type { PricingGroup } from '../../api/generated/models';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { rolePricingQuery } from '../orders/queries';
import { useRefresh } from './pricingShared';

type Mapping = { roleId: string; roleName: string; groupId: string };

export function RoleMappingTab({ groups, canEdit }: { groups: PricingGroup[]; canEdit: boolean }) {
  const user = useCurrentUser();
  const refresh = useRefresh();
  const mapped = useQuery(rolePricingQuery());
  const canListRoles = hasPermission(user, PermissionId.rolesread);
  const roles = useQuery({
    queryKey: ['roles', 'all-for-pricing'],
    queryFn: () => listRoles({ limit: 100 }),
    enabled: canListRoles,
  });
  const [draft, setDraft] = useState<Mapping[] | null>(null);
  const defaultGroup = groups.find((group) => group.isDefault);
  const active = groups.filter((group) => group.active);

  const base: Mapping[] = [
    ...(mapped.data?.items ?? []).map((item) => ({
      roleId: item.roleId,
      roleName: item.roleName,
      groupId: item.pricingGroupId,
    })),
    ...(roles.data?.items ?? [])
      .filter((role) => !(mapped.data?.items ?? []).some((item) => item.roleId === role.id))
      .map((role) => ({ roleId: role.id, roleName: role.name, groupId: '' })),
  ];
  const rows = draft ?? base;
  const dirty = draft !== null;
  const save = useMutation({
    mutationFn: () => {
      const chosen = rows.filter((row) => row.groupId);
      return setRolePricingGroups({
        items: chosen.map((row, index) => ({
          roleId: row.roleId,
          pricingGroupId: row.groupId,
          priority: chosen.length - index,
        })),
      });
    },
    onSuccess: async () => {
      setDraft(null);
      await refresh();
    },
  });
  const changeDefault = useMutation({
    mutationFn: (id: string) => {
      const group = groups.find((item) => item.id === id)!;
      return updatePricingGroup(id, {
        expectedVersion: group.version,
        name: group.name,
        description: group.description ?? null,
        active: true,
        isDefault: true,
      });
    },
    onSuccess: refresh,
  });
  const edit = (next: Mapping[]) => setDraft(next);
  const move = (index: number, by: number) => {
    const next = [...rows];
    [next[index], next[index + by]] = [next[index + by], next[index]];
    edit(next);
  };

  if (mapped.isPending) return <FullPageLoading label="Loading role mapping" />;
  if (mapped.isError)
    return <ErrorState message="The role mapping could not be loaded." onRetry={() => mapped.refetch()} />;
  return (
    <Stack gap={5}>
      <InlineNotification
        kind="info"
        lowContrast
        hideCloseButton
        title="Accounts are priced by their roles"
        subtitle="Map each role to a pricing group. If an account has several roles, the mapped role highest in this list decides. A group on the job or on the organization wins over this."
      />
      <TableContainer
        title="Role mapping"
        description="Highest priority first. Jobs that already have a price keep it."
      >
        <Table aria-label="Roles and their pricing groups">
          <TableHead>
            <TableRow>
              <TableHeader>Priority</TableHeader>
              <TableHeader>Role</TableHeader>
              <TableHeader>Pricing group</TableHeader>
              {canEdit && (
                <TableHeader>
                  <span className="cds--visually-hidden">Order</span>
                </TableHeader>
              )}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={row.roleId}>
                <TableCell>{row.groupId ? index + 1 : '—'}</TableCell>
                <TableCell>
                  <strong>{row.roleName}</strong>
                </TableCell>
                <TableCell>
                  {canEdit ? (
                    <Select
                      id={`role-${row.roleId}`}
                      labelText={`Pricing group of the role ${row.roleName}`}
                      hideLabel
                      size="sm"
                      value={row.groupId}
                      onChange={(event) =>
                        edit(
                          rows.map((item) =>
                            item.roleId === row.roleId ? { ...item, groupId: event.target.value } : item,
                          ),
                        )
                      }
                    >
                      <SelectItem
                        value=""
                        text={`Not mapped${defaultGroup ? ` (default group ${defaultGroup.name})` : ''}`}
                      />
                      {groups
                        .filter((group) => group.active || group.id === row.groupId)
                        .map((group) => (
                          <SelectItem
                            key={group.id}
                            value={group.id}
                            text={`${group.name}${group.active ? '' : ' (inactive)'}`}
                          />
                        ))}
                    </Select>
                  ) : (
                    (groups.find((group) => group.id === row.groupId)?.name ??
                    `Not mapped${defaultGroup ? ` (default group ${defaultGroup.name})` : ''}`)
                  )}
                </TableCell>
                {canEdit && (
                  <TableCell className="sales-row-actions">
                    <IconButton
                      label={`Move ${row.roleName} up`}
                      kind="ghost"
                      size="sm"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp />
                    </IconButton>
                    <IconButton
                      label={`Move ${row.roleName} down`}
                      kind="ghost"
                      size="sm"
                      disabled={index === rows.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown />
                    </IconButton>
                  </TableCell>
                )}
              </TableRow>
            ))}
            <TableRow>
              <TableCell>—</TableCell>
              <TableCell>
                <strong>No mapped role</strong>
                <br />
                <span className="mj-secondary">The default group</span>
              </TableCell>
              <TableCell>
                {canEdit ? (
                  <Select
                    id="role-default"
                    labelText="Default pricing group"
                    hideLabel
                    size="sm"
                    value={defaultGroup?.id ?? ''}
                    disabled={changeDefault.isPending}
                    onChange={(event) => changeDefault.mutate(event.target.value)}
                  >
                    {active.map((group) => (
                      <SelectItem key={group.id} value={group.id} text={group.name} />
                    ))}
                  </Select>
                ) : (
                  (defaultGroup?.name ?? '—')
                )}
              </TableCell>
              {canEdit && <TableCell />}
            </TableRow>
          </TableBody>
        </Table>
        {!canListRoles && canEdit && (
          <p className="mj-secondary sales-top-gap">
            Only mapped roles are listed. Listing every role needs the permission to read roles.
          </p>
        )}
      </TableContainer>
      {(save.isError || changeDefault.isError) && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Not saved"
          subtitle={(save.error ?? changeDefault.error)?.message}
        />
      )}
      {canEdit && (
        <div className="mj-inline">
          <Button kind="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save role mapping'}
          </Button>
          <Button kind="ghost" disabled={!dirty || save.isPending} onClick={() => setDraft(null)}>
            Discard changes
          </Button>
        </div>
      )}
    </Stack>
  );
}
