import './styles.scss';
import { useRef, useState } from 'react';
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
import { Add } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { QueryBoundary } from './components';
import { useNow } from './preview';
import { signagePaths } from './paths';
import { embedsQuery, groupsQuery } from './queries';
import { EmbedExtraTags, EmbedStatusTag } from './webEmbedParts';
import { NewWebEmbedModal } from './WebEmbedDialogs';
import { hostOf, lastLoaded } from './webEmbeds';
import { pluralize } from './helpers';

export function WebEmbedsPage() {
  const navigate = useNavigate();
  const canManage = hasPermission(useCurrentUser(), PermissionId.signagemanage);
  const [creating, setCreating] = useState(false);
  const newLauncher = useRef<HTMLButtonElement | null>(null);
  const now = useNow(30_000);
  const query = useQuery(embedsQuery());
  const groups = useQuery(groupsQuery()).data?.items;
  const embeds = query.data?.items ?? [];
  const newButton = canManage ? (
    <Button ref={newLauncher} renderIcon={Add} onClick={() => setCreating(true)}>
      New web embed
    </Button>
  ) : undefined;

  return (
    <PageShell title="Web embeds" width="wide" breadcrumbs={[{ label: 'Signage' }]} actions={newButton}>
      <p className="sg-secondary">
        Show a signage screen on another website. An embed works like a display without a device: it has its own scenes
        or follows a group, and only the websites you list may show it.
      </p>
      <QueryBoundary query={query} label="web embeds">
        {embeds.length === 0 ? (
          <EmptyState
            title="No web embeds yet"
            description="A web embed shows open days, events and printer status inside a website you choose."
            action={newButton}
          />
        ) : (
          <TableContainer>
            <Table aria-label="Web embeds">
              <TableHead>
                <TableRow>
                  <TableHeader>Name</TableHeader>
                  <TableHeader className="sg-hide-narrow">Content</TableHeader>
                  <TableHeader>Allowed websites</TableHeader>
                  <TableHeader className="sg-hide-narrow">Extra content</TableHeader>
                  <TableHeader>Status</TableHeader>
                  <TableHeader className="sg-hide-narrow">Loads today</TableHeader>
                </TableRow>
              </TableHead>
              <TableBody>
                {embeds.map((embed) => {
                  const group = embed.groupId ? groups?.find((item) => item.id === embed.groupId) : undefined;
                  return (
                    <TableRow
                      key={embed.id}
                      className="sg-row-link"
                      onClick={() => void navigate(signagePaths.embed(embed.id))}
                    >
                      <TableCell>
                        <CarbonLink
                          as={Link}
                          to={signagePaths.embed(embed.id)}
                          onClick={(event: React.MouseEvent) => event.stopPropagation()}
                        >
                          {embed.name}
                        </CarbonLink>
                      </TableCell>
                      <TableCell className="sg-hide-narrow">
                        {embed.groupId ? (
                          <>Follows group {group ? <strong>{group.name}</strong> : 'a display group'}</>
                        ) : (
                          `${pluralize(embed.defaultScenes.length, 'scene')}, own list`
                        )}
                      </TableCell>
                      <TableCell>
                        <div className="sg-cell-stack">
                          <span>{hostOf(embed.allowedOrigins[0] ?? '')}</span>
                          {embed.allowedOrigins.length > 1 && (
                            <span className="sg-secondary">+{embed.allowedOrigins.length - 1} more</span>
                          )}
                          {embed.openDirectly && <span className="sg-secondary">Link opens directly</span>}
                        </div>
                      </TableCell>
                      <TableCell className="sg-hide-narrow">
                        <EmbedExtraTags embed={embed} />
                      </TableCell>
                      <TableCell>
                        <div className="sg-cell-stack">
                          <EmbedStatusTag embed={embed} />
                          <span className="sg-secondary">{lastLoaded(embed, now)}</span>
                        </div>
                      </TableCell>
                      <TableCell className="sg-hide-narrow">{embed.loadsToday}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </QueryBoundary>
      {creating && <NewWebEmbedModal launcherButtonRef={newLauncher} onClose={() => setCreating(false)} />}
    </PageShell>
  );
}
