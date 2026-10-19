import './styles.scss';
import { useState } from 'react';
import { Button, InlineNotification, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag } from '@carbon/react';
import { Add, Edit, StopOutline } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SignageAnnouncement, SignageTone } from '../../api/generated/models';
import { stopSignageAnnouncement } from '../../api/generated/signage/signage';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { AnnouncementStartModal } from './AnnouncementStartModal';
import { QueryBoundary } from './components';
import { renderAnnouncement } from './engine/announcements';
import { errorMessage, formatMoment, isStaleWrite, pluralize } from './helpers';
import { useMachineOptions, useMakerspaceTimeZone, useNow } from './preview';
import { announcementsQuery, displaysQuery, signageKeys, templatesQuery } from './queries';

const TONE_TAG: Record<SignageTone, 'blue' | 'warm-gray' | 'red' | 'gray'> = { info: 'blue', warning: 'warm-gray', critical: 'red', neutral: 'gray' };

/** Starting, editing and stopping announcements. Live data: changes apply at once, nothing is published. */
export function AnnouncementsPage() {
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const canOverride = hasPermission(user, PermissionId.signageoverride);
  const canRead = hasPermission(user, PermissionId.signageread);
  const timeZone = useMakerspaceTimeZone();
  const { machines } = useMachineOptions();
  const now = useNow(30_000);
  const [editing, setEditing] = useState<SignageAnnouncement | 'new' | null>(null);
  const [stopping, setStopping] = useState<{ announcement: SignageAnnouncement; title: string } | null>(null);
  const query = useQuery({ ...announcementsQuery(), enabled: canRead, refetchInterval: 30_000 });
  const templates = useQuery({ ...templatesQuery(), enabled: canRead }).data?.items ?? [];
  const displays = useQuery({ ...displaysQuery(), enabled: canRead }).data?.items ?? [];

  const stop = useMutation({
    mutationFn: ({ announcement }: { announcement: SignageAnnouncement }) => stopSignageAnnouncement(announcement.id, { expectedVersion: announcement.version }),
    onSuccess: async () => { setStopping(null); await queryClient.invalidateQueries({ queryKey: signageKeys.all }); },
    onError: (error) => { if (isStaleWrite(error)) void queryClient.invalidateQueries({ queryKey: signageKeys.announcements() }); },
  });

  const all = query.data?.items ?? [];
  const active = all.filter((item) => item.status === 'active');
  const scheduled = all.filter((item) => item.status === 'scheduled');
  const description = query.isSuccess ? `${active.length} active · ${scheduled.length} scheduled` : 'Messages that appear on the displays right away, without publishing.';
  const create = canOverride && canRead ? <Button renderIcon={Add} onClick={() => setEditing('new')}>New announcement</Button> : undefined;
  const crumbs = [{ label: 'Signage' }];

  if (!canRead) {
    return (
      <PageShell title="Announcements" width="wide" breadcrumbs={crumbs} description={description}>
        <EmptyState title="Announcements cannot be listed" description="Starting and stopping announcements needs the permission to read signage as well. Ask an administrator to add it to your role." />
      </PageShell>
    );
  }

  const table = (items: SignageAnnouncement[], label: string, timing: (item: SignageAnnouncement) => string) => (
    <TableContainer title={label} description={pluralize(items.length, 'announcement')}>
      <Table aria-label={label}>
        <TableHead>
          <TableRow>
            <TableHeader>Message</TableHeader><TableHeader className="sg-hide-narrow">Template</TableHeader><TableHeader className="sg-hide-narrow">Displays</TableHeader><TableHeader>When</TableHeader>
            {canOverride && <TableHeader><span className="cds--visually-hidden">Actions</span></TableHeader>}
          </TableRow>
        </TableHead>
        <TableBody>
          {items.map((item) => {
            const template = templates.find((entry) => entry.id === item.templateId);
            const targets = item.allDisplays ? [] : displays.filter((display) => item.displayIds.includes(display.id));
            const displayNames = item.allDisplays ? 'All displays' : targets.map((display) => display.name).join(', ') || 'No display';
            // {display} and {location} need a screen: the first target stands in, several displays read as typed by the server.
            const rendered = template
              ? renderAnnouncement(template, item.values, { startsAt: new Date(item.startsAt), endsAt: item.endsAt ? new Date(item.endsAt) : null }, {
                now: new Date(now), timeZone, displayName: targets.length === 1 ? targets[0].name : 'each display', location: targets.length === 1 ? targets[0].location : '', machines: Object.fromEntries(machines.map((machine) => [machine.id, machine.name])),
              })
              : item.rendered;
            return (
              <TableRow key={item.id}>
                <TableCell>
                  <div className="sg-cell-stack">
                    <strong>{rendered.title}</strong>
                    {rendered.body && <span className="sg-secondary">{rendered.body}</span>}
                    <span className="sg-secondary sg-show-narrow">{template?.name} · {displayNames}</span>
                  </div>
                </TableCell>
                <TableCell className="sg-hide-narrow">{template ? <Tag size="sm" type={TONE_TAG[template.tone]}>{template.name}</Tag> : '—'}</TableCell>
                <TableCell className="sg-hide-narrow">{displayNames}</TableCell>
                <TableCell>{timing(item)}</TableCell>
                {canOverride && (
                  <TableCell>
                    <div className="sg-inline">
                      <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => setEditing(item)}>Edit</Button>
                      <Button kind="danger--ghost" size="sm" renderIcon={StopOutline} onClick={() => setStopping({ announcement: item, title: rendered.title })}>Stop</Button>
                    </div>
                  </TableCell>
                )}
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </TableContainer>
  );

  return (
    <PageShell title="Announcements" description={description} width="wide" breadcrumbs={crumbs} actions={create}>
      <QueryBoundary query={query} label="announcements">
        {all.length === 0 ? (
          <EmptyState title="No announcements" description="Nothing is shown or scheduled right now. Start one to put a message on the displays." action={create} />
        ) : (
          <div className="sg-stack">
            {active.length > 0 && table(active, 'Active', (item) => (item.endsAt ? `Until ${formatMoment(item.endsAt)}` : 'Until stopped'))}
            {scheduled.length > 0 && table(scheduled, 'Scheduled', (item) => `From ${formatMoment(item.startsAt)}${item.endsAt ? ` until ${formatMoment(item.endsAt)}` : ''}`)}
          </div>
        )}
      </QueryBoundary>
      <p className="sg-secondary sg-top-gap">Offline displays keep the announcements they already received and drop them at their end time, even if Core is unreachable.</p>
      {stop.isError && isStaleWrite(stop.error) && <InlineNotification kind="error" lowContrast hideCloseButton title="Already changed" subtitle="This announcement was changed or stopped by somebody else. The list was refreshed." />}
      {editing && <AnnouncementStartModal announcement={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      <DestructiveActionDialog
        open={stopping !== null} title="Stop announcement" confirmLabel="Stop announcement" pending={stop.isPending} error={stop.isError && !isStaleWrite(stop.error) ? errorMessage(stop.error) : undefined}
        onConfirm={() => { if (stopping) stop.mutate(stopping); }} onClose={() => { setStopping(null); stop.reset(); }}
      >
        <p>“{stopping?.title}” disappears from the displays right away. A stopped announcement is deleted, so it cannot be brought back; start a new one instead.</p>
      </DestructiveActionDialog>
    </PageShell>
  );
}
