import './styles.scss';
import { useState } from 'react';
import {
  Button,
  Link as CarbonLink,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { SignageDisplay, SignageDisplayGroup } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { RowActions } from '../../app/RowActions';
import { PlayerAddress, QueryBoundary } from './components';
import { DeleteDisplayDialog } from './DisplayDialogs';
import { NewGroupModal } from './GroupDialogs';
import { useRuleNames } from './displayHooks';
import { PublicationTag, StatusTag } from './displayParts';
import { DEFAULT_RULE_ID, describeCondition } from './engine/playback';
import { aspectLabel, pluralize } from './helpers';
import { useNow } from './preview';
import { PairDisplayModal } from './PairDisplayModal';
import { signagePaths } from './paths';
import { toPlaybackRule } from './publishedView';
import { displaysQuery, embedsQuery, groupsQuery, rulesQuery, scenesQuery } from './queries';
import { memberSummary } from './webEmbeds';

/** What the display reported it plays (heartbeat), with names; a rule is spelled out from the display's rule list. */
function NowShowing({ display }: { display: SignageDisplay }) {
  const scenes = useQuery(scenesQuery());
  const names = useRuleNames();
  const byRule = display.currentRule !== null && display.currentRule !== DEFAULT_RULE_ID;
  const rules = useQuery(rulesQuery(display.id, byRule));
  if (display.status === 'revoked') return <span className="sg-secondary">Credential revoked</span>;
  if (display.currentRule === null && display.currentSceneId === null)
    return (
      <span className="sg-secondary">{display.lastHeartbeatAt ? 'Nothing reported' : 'Waiting for the player'}</span>
    );
  const scene = scenes.data?.items.find((item) => item.id === display.currentSceneId);
  const index = byRule ? (rules.data?.items.findIndex((item) => item.id === display.currentRule) ?? -1) : -1;
  const rule = index >= 0 ? rules.data?.items[index] : undefined;
  let reason = 'Rule';
  if (!byRule) reason = 'Default scenes';
  else if (rule) reason = `Rule ${index + 1}: ${describeCondition(toPlaybackRule(rule), names)}`;
  return (
    <div className="sg-cell-stack">
      <span>{scene?.name ?? (display.currentSceneId ? 'Scene removed' : '—')}</span>
      <span className="sg-secondary">{reason}</span>
    </div>
  );
}

/** Display groups: displays that share rules and default scenes and are published together. */
function GroupsSection({ canManage }: { canManage: boolean }) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const query = useQuery(groupsQuery());
  const displayItems = useQuery(displaysQuery()).data?.items;
  const embedItems = useQuery(embedsQuery()).data?.items;
  const groups: SignageDisplayGroup[] = query.data?.items ?? [];
  const newButton = canManage ? (
    <Button kind="tertiary" size="md" renderIcon={Add} onClick={() => setCreating(true)}>
      New group
    </Button>
  ) : undefined;
  return (
    <section className="sg-stack" aria-labelledby="signage-groups-title">
      <div className="sg-tab__bar">
        <div>
          <h2 id="signage-groups-title" className="sg-section-title">
            Groups
          </h2>
          <p className="sg-secondary">Displays of a group show the same thing and are published together.</p>
        </div>
        {newButton}
      </div>
      <QueryBoundary query={query} label="groups">
        {groups.length === 0 ? (
          <EmptyState
            title="No groups yet"
            description="Put displays with the same aspect ratio into a group to manage their rules and default scenes in one place."
            action={newButton}
          />
        ) : (
          <TableContainer>
            <Table aria-label="Groups">
              <TableHead>
                <TableRow>
                  <TableHeader>Name</TableHeader>
                  <TableHeader className="sg-hide-narrow">Aspect ratio</TableHeader>
                  <TableHeader>Members</TableHeader>
                  <TableHeader>Publication</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {groups.map((group) => (
                  <TableRow
                    key={group.id}
                    className="sg-row-link"
                    onClick={() => void navigate(signagePaths.group(group.id))}
                  >
                    <TableCell>
                      <CarbonLink
                        as={Link}
                        to={signagePaths.group(group.id)}
                        onClick={(event: React.MouseEvent) => event.stopPropagation()}
                      >
                        {group.name}
                      </CarbonLink>
                    </TableCell>
                    <TableCell className="sg-hide-narrow">{aspectLabel(group.aspectRatio)}</TableCell>
                    <TableCell>
                      {memberSummary(
                        displayItems?.filter((item) => item.groupId === group.id).length ?? group.displayIds.length,
                        embedItems?.filter((item) => item.groupId === group.id).length ?? 0,
                      )}
                    </TableCell>
                    <TableCell>
                      {group.pendingChanges.length > 0 ? (
                        <Tag type="warm-gray" size="md">
                          {pluralize(group.pendingChanges.length, 'unpublished change')}
                        </Tag>
                      ) : (
                        <Tag type="green" size="md">
                          Up to date
                        </Tag>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </QueryBoundary>
      {creating && <NewGroupModal onClose={() => setCreating(false)} />}
    </section>
  );
}

export function DisplaysPage() {
  const navigate = useNavigate();
  const canPair = hasPermission(useCurrentUser(), PermissionId.signagemanage);
  const canManage = canPair;
  const [pairing, setPairing] = useState(false);
  const [deleting, setDeleting] = useState<SignageDisplay | null>(null);
  const now = useNow(30_000);
  const query = useQuery(displaysQuery());
  const displays = query.data?.items ?? [];
  const pairButton = canPair ? (
    <Button renderIcon={Add} onClick={() => setPairing(true)}>
      Pair display
    </Button>
  ) : undefined;

  return (
    <PageShell title="Displays" width="wide" breadcrumbs={[{ label: 'Signage' }]} actions={pairButton}>
      <QueryBoundary query={query} label="displays">
        {displays.length === 0 ? (
          <EmptyState
            title="No displays yet"
            description="On the screen, open this address in the kiosk browser. It shows a 6-character code that you enter here."
            action={
              <div className="sg-stack">
                <PlayerAddress />
                {pairButton}
              </div>
            }
          />
        ) : (
          <TableContainer>
            <Table aria-label="Displays">
              <TableHead>
                <TableRow>
                  <TableHeader>Name</TableHeader>
                  <TableHeader className="sg-hide-narrow">Aspect ratio</TableHeader>
                  <TableHeader>Status</TableHeader>
                  <TableHeader>Now showing</TableHeader>
                  <TableHeader className="sg-hide-narrow">Publication</TableHeader>
                  {canManage && (
                    <TableHeader>
                      <span className="cds--visually-hidden">Actions</span>
                    </TableHeader>
                  )}
                </TableRow>
              </TableHead>
              <TableBody>
                {displays.map((display) => (
                  <TableRow
                    key={display.id}
                    className="sg-row-link"
                    onClick={() => void navigate(signagePaths.display(display.id))}
                  >
                    <TableCell>
                      <div className="sg-cell-stack">
                        <CarbonLink
                          as={Link}
                          to={signagePaths.display(display.id)}
                          onClick={(event: React.MouseEvent) => event.stopPropagation()}
                        >
                          {display.name}
                        </CarbonLink>
                        {display.location && <span className="sg-secondary">{display.location}</span>}
                      </div>
                    </TableCell>
                    <TableCell className="sg-hide-narrow">{aspectLabel(display.aspectRatio)}</TableCell>
                    <TableCell>
                      <StatusTag display={display} now={now} />
                    </TableCell>
                    <TableCell>
                      <NowShowing display={display} />
                    </TableCell>
                    <TableCell className="sg-hide-narrow">
                      <PublicationTag display={display} />
                    </TableCell>
                    {canManage && (
                      <TableCell onClick={(event: React.MouseEvent) => event.stopPropagation()}>
                        <RowActions label={`Actions for ${display.name}`}>
                          <Button
                            kind="danger--ghost"
                            size="sm"
                            renderIcon={TrashCan}
                            onClick={() => setDeleting(display)}
                          >
                            Delete
                          </Button>
                        </RowActions>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </QueryBoundary>
      <GroupsSection canManage={canManage} />
      {deleting && <DeleteDisplayDialog display={deleting} onClose={() => setDeleting(null)} />}
      {pairing && <PairDisplayModal onClose={() => setPairing(false)} />}
    </PageShell>
  );
}
