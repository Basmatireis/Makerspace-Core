import { useState } from 'react';
import { Button, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, Tag } from '@carbon/react';
import { Add, Edit, StopOutline } from '@carbon/icons-react';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { RequirePermission } from '../../sales/components/RequirePermission';
import { useNow, useStore } from '../../store';
import { AnnouncementStartModal } from '../dialogs/AnnouncementStartModal';
import { renderFor, pluralize } from '../helpers';
import { useSignage } from '../SignageContext';
import { useSignageQuery } from '../useSignageQuery';
import type { Announcement, Tone } from '../types';
import '../signage.scss';

const TONE_TAG: Record<Tone, 'blue' | 'warm-gray' | 'red' | 'gray'> = { info: 'blue', warning: 'warm-gray', critical: 'red', neutral: 'gray' };
const formatMoment = (iso: string) => new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Starting and stopping announcements (`signage.override`). Viewing needs `signage.read` or `signage.override`. */
export function AnnouncementsPage() {
  const store = useStore();
  const signage = useSignage();
  const now = useNow(1000);
  const [editing, setEditing] = useState<Announcement | 'new' | null>(null);
  const query = useSignageQuery(signage.announcements, []);
  const canOverride = store.can('signage.override');
  const canView = canOverride || store.can('signage.read');
  const crumbs = [{ label: 'Signage' }];

  const open = query.data.filter((item) => !item.endsAt || Date.parse(item.endsAt) > now).sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt));
  const active = open.filter((item) => Date.parse(item.startsAt) <= now);
  const scheduled = open.filter((item) => Date.parse(item.startsAt) > now);
  const description = query.status === 'success' ? `${active.length} active · ${scheduled.length} scheduled` : 'Messages that appear on the displays right away, without publishing.';
  const create = canOverride ? <Button renderIcon={Add} onClick={() => setEditing('new')}>New announcement</Button> : undefined;

  const stop = (item: Announcement, title: string) => {
    signage.stopAnnouncement(item.id);
    store.notify({ kind: 'success', title: 'Announcement stopped', subtitle: title });
  };

  const table = (items: Announcement[], label: string, timing: (item: Announcement) => string) => (
    <TableContainer className="mj-table-container" title={label} description={pluralize(items.length, 'announcement')}>
      <Table aria-label={label}>
        <TableHead>
          <TableRow>
            <TableHeader>Message</TableHeader><TableHeader className="mj-hide-narrow">Template</TableHeader><TableHeader className="mj-hide-narrow">Displays</TableHeader><TableHeader>When</TableHeader>
            {canOverride && <TableHeader><span className="cds--visually-hidden">Actions</span></TableHeader>}
          </TableRow>
        </TableHead>
        <TableBody>
          {items.map((item) => {
            const template = signage.announcementTemplates.find((entry) => entry.id === item.templateId);
            const targets = item.displayIds ? signage.displays.filter((display) => item.displayIds?.includes(display.id)) : [];
            const displayNames = item.displayIds === null ? 'All displays' : targets.map((display) => display.name).join(', ') || 'No display';
            const rendered = template ? renderFor(item, template, { name: targets[0]?.name ?? 'All displays', location: targets[0]?.location ?? '' }, new Date(now)) : null;
            return (
              <TableRow key={item.id}>
                <TableCell>
                  <div className="mj-cell-stack">
                    <strong>{rendered?.title ?? 'Template removed'}</strong>
                    {rendered?.body && <span className="mj-secondary">{rendered.body}</span>}
                    <span className="mj-secondary mj-show-narrow">{template?.name} · {displayNames}</span>
                  </div>
                </TableCell>
                <TableCell className="mj-hide-narrow">{template ? <Tag size="sm" type={TONE_TAG[template.tone]}>{template.name}</Tag> : '—'}</TableCell>
                <TableCell className="mj-hide-narrow">{displayNames}</TableCell>
                <TableCell>{timing(item)}</TableCell>
                {canOverride && (
                  <TableCell>
                    <div className="mj-inline">
                      <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => setEditing(item)}>Edit</Button>
                      <Button kind="danger--ghost" size="sm" renderIcon={StopOutline} onClick={() => stop(item, rendered?.title ?? '')}>Stop</Button>
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
    <RequirePermission permission={canView ? [] : 'signage.override'} title="Announcements" crumbs={crumbs}>
      <PageShell title="Announcements" description={description} width="wide" breadcrumbs={crumbs} actions={create}>
        <QueryBoundary query={query} errorMessage="The announcements could not be loaded.">
          {open.length === 0 ? (
            <EmptyState title="No announcements" description="Nothing is shown or scheduled right now. Start one to put a message on the displays." action={create} />
          ) : (
            <div className="mj-stack">
              {active.length > 0 && table(active, 'Active', (item) => (item.endsAt ? `Until ${formatMoment(item.endsAt)}` : 'Until stopped'))}
              {scheduled.length > 0 && table(scheduled, 'Scheduled', (item) => `From ${formatMoment(item.startsAt)}${item.endsAt ? ` until ${formatMoment(item.endsAt)}` : ''}`)}
            </div>
          )}
        </QueryBoundary>
        <p className="mj-secondary sg-top-gap">Offline displays keep the announcements they already received and drop them at their end time, even if Core is unreachable.</p>
        {editing && <AnnouncementStartModal announcement={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      </PageShell>
    </RequirePermission>
  );
}
