import { Button } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { PageSectionTabs } from '../machinelogbook/components/machineParts';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { GroupOverview } from './GroupOverview';
import { ManagementOverview } from './ManagementOverview';
import { canManageWorkingGroups, editableWorkingGroups, orderGroups, workingGroupsOptions } from './queries';
import './workinggroups.scss';

/** Working groups → Overview: one tab per group with its pinboard, people, machines and places. */
export function WorkingGroupsPage() {
  const currentUser = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const list = useQuery(workingGroupsOptions);
  const groups = orderGroups(list.data?.items ?? []);
  const canSetUp = canManageWorkingGroups(currentUser);
  const management = canSetUp || hasPermission(currentUser, PermissionId.working_group_financesmanage);
  const requested = params.get('group');
  const own = groups.some((group) => group.isMember || group.isLead);
  const all = management && (requested === 'all' || (requested === null && !own));
  const selected = groups.find((group) => group.id === requested) ?? groups[0];
  const select = (id: string) =>
    setParams(
      (previous) => {
        const updated = new URLSearchParams(previous);
        updated.set('group', id);
        return updated;
      },
      { replace: true },
    );

  if (list.isPending || list.isError || groups.length === 0 || !selected) {
    return (
      <PageShell title="Working groups">
        <QueryBoundary query={list}>
          <EmptyState
            title="No working groups yet"
            description="Groups look after machines and places."
            action={
              canSetUp ? (
                <Button as={Link} to="/settings/working-groups">
                  Set up working groups
                </Button>
              ) : undefined
            }
          />
        </QueryBoundary>
      </PageShell>
    );
  }

  return (
    <PageShell
      title={all ? 'All groups' : selected.name}
      width="wide"
      breadcrumbs={[{ label: 'Working groups', to: '/working-groups' }]}
      actions={
        !all &&
        editableWorkingGroups(currentUser, [selected]).length > 0 && (
          <Button as={Link} to={`/settings/working-groups?tab=${selected.id}`} kind="tertiary">
            Manage group
          </Button>
        )
      }
      tabs={
        <PageSectionTabs
          label="Working groups"
          sections={[
            ...(management ? [{ id: 'all', label: 'All groups' }] : []),
            ...groups.map((group) => ({ id: group.id, label: group.name })),
          ]}
          selected={all ? 'all' : selected.id}
          onChange={select}
        />
      }
    >
      {all ? <ManagementOverview groups={groups} onOpenGroup={select} /> : <GroupOverview summary={selected} />}
    </PageShell>
  );
}
