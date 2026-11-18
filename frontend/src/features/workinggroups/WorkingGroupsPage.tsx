import { Button, Link as CarbonLink, ListItem, Tag, UnorderedList } from '@carbon/react';
import { Launch } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import type { WorkingGroup, WorkingGroupSummary } from '../../api/generated/models';
import { DetailPanel, DetailPanelSection } from '../../app/components/DetailPanel';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { PageSectionTabs } from '../machinelogbook/components/machineParts';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { canManageWorkingGroups, editableWorkingGroups, workingGroupOptions, workingGroupsOptions } from './queries';
import './workinggroups.scss';

function isHttps(url: string | undefined): url is string {
  try {
    return url !== undefined && new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** The caller's own groups first, then the others, each by name. */
function orderGroups(groups: readonly WorkingGroupSummary[]): WorkingGroupSummary[] {
  const own = groups.filter((group) => group.isMember || group.isLead).sort(byName);
  const others = groups.filter((group) => !group.isMember && !group.isLead).sort(byName);
  return [...own, ...others];
}

/** Working groups → Overview: who looks after which machines and places. */
export function WorkingGroupsPage() {
  const currentUser = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const list = useQuery(workingGroupsOptions);
  const groups = orderGroups(list.data?.items ?? []);
  const selected = groups.find((group) => group.id === params.get('group')) ?? groups[0];
  const canSetUp = canManageWorkingGroups(currentUser);

  if (list.isPending || list.isError || groups.length === 0 || !selected) {
    return (
      <PageShell title="Working groups">
        <QueryBoundary query={list}>
          <EmptyState
            title="No working groups yet"
            description="Working groups look after machines and places of the makerspace."
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
      title={selected.name}
      breadcrumbs={[{ label: 'Working groups', to: '/working-groups' }]}
      actions={
        editableWorkingGroups(currentUser, [selected]).length > 0 && (
          <Button as={Link} to={`/settings/working-groups?tab=${selected.id}`} kind="tertiary">
            Manage group
          </Button>
        )
      }
      tabs={
        <PageSectionTabs
          label="Working groups"
          sections={groups.map((group) => ({ id: group.id, label: group.name }))}
          selected={selected.id}
          onChange={(id) =>
            setParams(
              (previous) => {
                const updated = new URLSearchParams(previous);
                updated.set('group', id);
                return updated;
              },
              { replace: true },
            )
          }
        />
      }
    >
      <GroupDetail summary={selected} />
    </PageShell>
  );
}

function GroupDetail({ summary }: { summary: WorkingGroupSummary }) {
  const detail = useQuery(workingGroupOptions(summary.id));
  const relation = summary.isLead ? 'You lead this group.' : summary.isMember ? 'You are a member.' : null;
  return (
    <>
      {(summary.description || relation) && (
        <p className="wg-description">{[summary.description, relation].filter(Boolean).join(' ')}</p>
      )}
      <QueryBoundary query={detail} errorMessage="The working group could not be loaded.">
        {(group) => <GroupColumns group={group} />}
      </QueryBoundary>
    </>
  );
}

function GroupColumns({ group }: { group: WorkingGroup }) {
  const members = [...group.members].sort(
    (a, b) => Number(b.isLead) - Number(a.isLead) || a.displayName.localeCompare(b.displayName),
  );
  const machines = [...group.machines].sort(byName);
  const places = [...group.places].sort(byName);
  return (
    <div className="wg-layout">
      <DetailPanel>
        <DetailPanelSection title="Machines and places">
          {machines.length + places.length === 0 ? (
            <p>This group looks after no machines or places yet.</p>
          ) : (
            <UnorderedList nested={false}>
              {machines.map((machine) => (
                <ListItem key={machine.id}>
                  {machine.name} <Tag size="sm">Machine</Tag>
                </ListItem>
              ))}
              {places.map((place) => (
                <ListItem key={place.id}>
                  {place.name} <Tag size="sm">Place</Tag>
                </ListItem>
              ))}
            </UnorderedList>
          )}
        </DetailPanelSection>
      </DetailPanel>
      <aside aria-label="People and chat">
        <DetailPanel>
          <DetailPanelSection title="People">
            {members.length === 0 ? (
              <p>This group has no members.</p>
            ) : (
              <UnorderedList nested={false}>
                {members.map((member) => (
                  <ListItem key={member.personId}>
                    {member.displayName}{' '}
                    {member.isLead && (
                      <Tag size="sm" type="purple">
                        Group lead
                      </Tag>
                    )}
                  </ListItem>
                ))}
              </UnorderedList>
            )}
          </DetailPanelSection>
          {isHttps(group.chatUrl) && (
            <DetailPanelSection title="Group chat">
              <CarbonLink href={group.chatUrl} target="_blank" rel="noreferrer noopener" renderIcon={Launch}>
                Open the group chat
              </CarbonLink>
            </DetailPanelSection>
          )}
        </DetailPanel>
      </aside>
    </div>
  );
}
