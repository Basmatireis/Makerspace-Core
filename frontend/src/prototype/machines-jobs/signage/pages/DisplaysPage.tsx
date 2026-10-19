import { useState } from 'react';
import { Button, Link as CarbonLink, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { Link, useNavigate } from 'react-router-dom';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { useNow, useStore } from '../../store';
import { RequirePermission } from '../../sales/components/RequirePermission';
import { PairDisplayModal } from '../dialogs/PairDisplayModal';
import { playbackOf, orientationLabel, targetName } from '../helpers';
import { useSignage } from '../SignageContext';
import { useSignageQuery } from '../useSignageQuery';
import { PublicationTag, StatusTag } from '../components/Tags';
import '../signage.scss';

export function DisplaysPage() {
  const store = useStore();
  const signage = useSignage();
  const now = useNow(5000);
  const navigate = useNavigate();
  const [pairing, setPairing] = useState(false);
  const query = useSignageQuery(signage.displays, []);
  const displays = query.data;
  const canPair = store.can('signage.manage');
  const online = displays.filter((display) => display.status === 'online' && !display.revoked).length;
  const needsPublishing = displays.filter((display) => display.pending.length > 0 && !display.revoked).length;
  const description = query.status === 'success' ? `${displays.length} ${displays.length === 1 ? 'display' : 'displays'} · ${online} online · ${needsPublishing} ${needsPublishing === 1 ? 'needs' : 'need'} publishing` : 'Screens that show scenes and playlists in the makerspace.';
  const pairButton = canPair ? <Button renderIcon={Add} onClick={() => setPairing(true)}>Pair display</Button> : undefined;

  return (
    <RequirePermission permission="signage.read" title="Displays" crumbs={[{ label: 'Signage' }]}>
      <PageShell title="Displays" description={description} width="wide" breadcrumbs={[{ label: 'Signage' }]} actions={pairButton}>
        <QueryBoundary query={query} errorMessage="The displays could not be loaded.">
          {displays.length === 0 ? (
            <EmptyState title="No displays yet" description="Start the player on a screen, then enter the code it shows." action={canPair ? <Button renderIcon={Add} onClick={() => setPairing(true)}>Pair display</Button> : undefined} />
          ) : (
            <TableContainer className="mj-table-container">
              <Table aria-label="Displays">
                <TableHead>
                  <TableRow>
                    <TableHeader>Name</TableHeader><TableHeader className="mj-hide-narrow">Orientation</TableHeader><TableHeader>Status</TableHeader>
                    <TableHeader>Now showing</TableHeader><TableHeader className="mj-hide-narrow">Publication</TableHeader>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {displays.map((display) => {
                    const playback = playbackOf(display, signage.sim, now);
                    return (
                      <TableRow key={display.id} className="mj-table-row" onClick={() => navigate(`/signage/displays/${display.id}`)}>
                        <TableCell>
                          <div className="mj-cell-stack">
                            <CarbonLink as={Link} to={`/signage/displays/${display.id}`} onClick={(event: React.MouseEvent) => event.stopPropagation()}>{display.name}</CarbonLink>
                            <span className="mj-secondary">{display.location}</span>
                            <span className="mj-secondary mj-show-narrow">{orientationLabel(display)}</span>
                          </div>
                        </TableCell>
                        <TableCell className="mj-hide-narrow">{orientationLabel(display)}</TableCell>
                        <TableCell><StatusTag display={display} now={now} /></TableCell>
                        <TableCell>
                          {display.revoked ? <span className="mj-secondary">Credential revoked</span> : (
                            <div className="mj-cell-stack"><span>{targetName(playback.target, display.published.scenes, display.published.playlists).replace(/^(Scene|Playlist) /, '')}</span><span className="mj-secondary">{playback.reason}</span></div>
                          )}
                        </TableCell>
                        <TableCell className="mj-hide-narrow"><PublicationTag display={display} /></TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </QueryBoundary>
        {pairing && <PairDisplayModal onClose={() => setPairing(false)} />}
      </PageShell>
    </RequirePermission>
  );
}
