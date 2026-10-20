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
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import type { SignageDisplay } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { RowActions } from '../../app/RowActions';
import { PlayerAddress, QueryBoundary } from './components';
import { DeleteDisplayDialog } from './DisplayDialogs';
import { useRuleNames } from './displayHooks';
import { PublicationTag, StatusTag } from './displayParts';
import { DEFAULT_RULE_ID, describeCondition } from './engine/playback';
import { orientationLabel, pluralize, resolutionLabel } from './helpers';
import { useNow } from './preview';
import { PairDisplayModal } from './PairDisplayModal';
import { signagePaths } from './paths';
import { toPlaybackRule } from './publishedView';
import { displaysQuery, playlistsQuery, rulesQuery, scenesQuery } from './queries';

/** What the display reported it plays (heartbeat), with names; a rule is spelled out from the display's rule list. */
function NowShowing({ display }: { display: SignageDisplay }) {
  const scenes = useQuery(scenesQuery());
  const playlists = useQuery(playlistsQuery());
  const names = useRuleNames();
  const byRule = display.currentRule !== null && display.currentRule !== DEFAULT_RULE_ID;
  const rules = useQuery(rulesQuery(display.id, byRule));
  if (display.status === 'revoked') return <span className="sg-secondary">Credential revoked</span>;
  if (display.currentRule === null && display.currentSceneId === null)
    return (
      <span className="sg-secondary">{display.lastHeartbeatAt ? 'Nothing reported' : 'Waiting for the player'}</span>
    );
  const scene = scenes.data?.items.find((item) => item.id === display.currentSceneId);
  const defaultPlaylist = playlists.data?.items.find((item) => item.id === display.defaultPlaylistId);
  const index = byRule ? (rules.data?.items.findIndex((item) => item.id === display.currentRule) ?? -1) : -1;
  const rule = index >= 0 ? rules.data?.items[index] : undefined;
  let reason = 'Rule';
  if (!byRule) reason = defaultPlaylist ? `Default playlist ${defaultPlaylist.name}` : 'Default playlist';
  else if (rule) reason = `Rule ${index + 1}: ${describeCondition(toPlaybackRule(rule), names)}`;
  return (
    <div className="sg-cell-stack">
      <span>{scene?.name ?? (display.currentSceneId ? 'Scene removed' : '—')}</span>
      <span className="sg-secondary">{reason}</span>
    </div>
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
  const active = displays.filter((display) => display.status !== 'revoked');
  const online = active.filter((display) => display.status === 'online').length;
  const needsPublishing = active.filter(
    (display) => display.publishedRevision === null || display.pendingChanges.length > 0,
  ).length;
  const description = query.isSuccess
    ? `${pluralize(displays.length, 'display')} · ${online} online · ${needsPublishing} ${needsPublishing === 1 ? 'needs' : 'need'} publishing`
    : 'Screens that show scenes and playlists in the makerspace.';
  const pairButton = canPair ? (
    <Button renderIcon={Add} onClick={() => setPairing(true)}>
      Pair display
    </Button>
  ) : undefined;

  return (
    <PageShell
      title="Displays"
      description={description}
      width="wide"
      breadcrumbs={[{ label: 'Signage' }]}
      actions={pairButton}
    >
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
                  <TableHeader className="sg-hide-narrow">Orientation</TableHeader>
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
                    onClick={() => navigate(signagePaths.display(display.id))}
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
                    <TableCell className="sg-hide-narrow">
                      {orientationLabel(display.orientation)}{' '}
                      <span className="sg-secondary">{resolutionLabel(display.resolution)}</span>
                    </TableCell>
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
      {deleting && <DeleteDisplayDialog display={deleting} onClose={() => setDeleting(null)} />}
      {pairing && <PairDisplayModal onClose={() => setPairing(false)} />}
    </PageShell>
  );
}
