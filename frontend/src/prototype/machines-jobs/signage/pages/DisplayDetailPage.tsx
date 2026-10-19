import { useState } from 'react';
import { ActionableNotification, Button, InlineNotification, Link as CarbonLink, OverflowMenu, OverflowMenuItem, Tab, TabList, TabPanel, TabPanels, Tabs, Tag, Tile } from '@carbon/react';
import { Bullhorn, Launch, Upload } from '@carbon/icons-react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { DestructiveActionDialog } from '../../../../app/DestructiveActionDialog';
import { PageShell } from '../../../../app/PageShell';
import { EmptyState } from '../../../../app/PageState';
import { QueryBoundary } from '../../components/QueryBoundary';
import { RequirePermission } from '../../sales/components/RequirePermission';
import { useNow, useSimulatedMutation, useStore } from '../../store';
import { AnnouncementModal } from '../dialogs/AnnouncementModal';
import { RenameModal } from '../dialogs/TextEditModals';
import { DisplayScreen } from '../components/DisplayScreen';
import { DisplaySettingsTab } from '../components/DisplaySettingsTab';
import { HealthTab } from '../components/HealthTab';
import { PlaybackTab } from '../components/PlaybackTab';
import { StatusTag } from '../components/Tags';
import { orientationLabel, playbackOf, pluralize, targetName } from '../helpers';
import { useSignage } from '../SignageContext';
import { useSignageQuery } from '../useSignageQuery';
import '../signage.scss';

export function DisplayDetailPage() {
  const { displayId = '' } = useParams();
  const signage = useSignage();
  const display = signage.displays.find((item) => item.id === displayId) ?? null;
  const query = useSignageQuery(display, null);
  const crumbs = [{ label: 'Signage' }, { label: 'Displays', to: '/signage' }];
  return (
    <RequirePermission permission="signage.read" title="Display" crumbs={crumbs}>
      {query.status === 'success' && !display ? (
        <PageShell title="Display not found" breadcrumbs={crumbs} width="wide"><EmptyState title="This display does not exist" description="It may have been deleted." action={<Button kind="tertiary" as={Link} to="/signage">Back to displays</Button>} /></PageShell>
      ) : query.status !== 'success' || !query.data ? (
        <PageShell title="Display" breadcrumbs={crumbs} width="wide"><QueryBoundary query={query} errorMessage="The display could not be loaded."><EmptyState title="No data" description="There is nothing to show in this data state." /></QueryBoundary></PageShell>
      ) : <Detail displayId={displayId} crumbs={crumbs} />}
    </RequirePermission>
  );
}

function Detail({ displayId, crumbs }: { displayId: string; crumbs: { label: string; to?: string }[] }) {
  const store = useStore();
  const signage = useSignage();
  const navigate = useNavigate();
  const now = useNow(1000);
  const display = signage.displays.find((item) => item.id === displayId)!;
  const [renaming, setRenaming] = useState(false);
  const [announcing, setAnnouncing] = useState(false);
  const [confirm, setConfirm] = useState<'revoke' | 'delete' | null>(null);
  const playback = playbackOf(display, signage.sim, now);
  const publish = useSimulatedMutation(() => signage.publishDisplay(display.id), 900);
  const canPublish = store.can('signage.publish') && !display.revoked;
  const canManage = store.can('signage.manage');
  const canOverride = store.can('signage.override') && !display.revoked;
  const pendingCount = display.pending.length;

  const doPublish = async () => {
    await publish.mutate();
    store.notify({ kind: 'success', title: 'Published', subtitle: `${display.name} now runs revision ${display.revision + 1}.` });
  };

  const actions = (
    <>
      {canOverride && !display.announcement && <Button kind="tertiary" renderIcon={Bullhorn} onClick={() => setAnnouncing(true)}>Show announcement</Button>}
      {canPublish && pendingCount > 0 && <Button renderIcon={Upload} disabled={publish.pending} onClick={() => { void doPublish(); }}>{publish.pending ? 'Publishing…' : `Publish ${pluralize(pendingCount, 'change')}`}</Button>}
      <div>
        <OverflowMenu flipped aria-label="Display actions" iconDescription="Display actions">
          <OverflowMenuItem itemText="Open player" onClick={() => navigate(`/signage/play/${display.id}`)} disabled={display.revoked} />
          {canManage && <OverflowMenuItem itemText="Rename" onClick={() => setRenaming(true)} />}
          {canManage && !display.revoked && <OverflowMenuItem itemText="Rotate credential" onClick={() => signage.rotateCredential(display.id)} />}
          {canManage && !display.revoked && <OverflowMenuItem itemText="Revoke" isDelete hasDivider onClick={() => setConfirm('revoke')} />}
          {canManage && display.revoked && <OverflowMenuItem itemText="Delete" isDelete hasDivider onClick={() => setConfirm('delete')} />}
        </OverflowMenu>
      </div>
    </>
  );

  return (
    <PageShell
      title={display.name} width="wide" breadcrumbs={crumbs} description={`${display.location} · ${orientationLabel(display)}`} actions={actions}
      titleAdornment={display.revoked ? <Tag type="gray">Revoked</Tag> : pendingCount === 0 ? <Tag type="green">Up to date</Tag> : undefined}
    >
      <div className="mj-stack">
        {pendingCount > 0 && !display.revoked && <InlineNotification kind="info" lowContrast hideCloseButton title={`${pluralize(pendingCount, 'unpublished change')}`} subtitle={`${display.pending.join(' · ')}. The display keeps running its last publication until you publish.`} />}
        {display.announcement && (canOverride
          ? <ActionableNotification inline lowContrast hideCloseButton kind="warning" title="Announcement is on" subtitle={`${display.announcement.text ?? signage.scenes.find((scene) => scene.id === display.announcement?.sceneId)?.name ?? ''}${display.announcement.until ? ` until ${new Date(display.announcement.until).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}` : ' until stopped'}`} actionButtonLabel="Stop announcement" onActionButtonClick={() => { signage.stopAnnouncement(display.id); store.notify({ kind: 'success', title: 'Announcement stopped' }); }} />
          : <InlineNotification kind="warning" lowContrast hideCloseButton title="Announcement is on" subtitle="Someone with the announcement permission can stop it." />)}
        {signage.sim.announcement && <InlineNotification kind="warning" lowContrast hideCloseButton title="Simulated announcement is on" subtitle="Switch it off in the prototype controls." />}

        <div className="sg-detail">
          <Tile className="sg-detail__preview">
            <h2 className="mj-section-title">Live preview</h2>
            <div className={`sg-detail__frame sg-detail__frame--${display.orientation}`}>
              <DisplayScreen display={display} sim={signage.sim} now={now} media={signage.media} width={display.orientation === 'portrait' ? '14rem' : '100%'} />
            </div>
            <div className="mj-stack sg-detail__now">
              <p>Now showing <strong>{targetName(playback.target, display.published.scenes, display.published.playlists).replace(/^(Scene|Playlist) /, '')}</strong> — <span className="mj-secondary">{playback.reason}</span></p>
              <div className="mj-inline"><StatusTag display={display} now={now} /></div>
              {!display.revoked && <CarbonLink as={Link} to={`/signage/play/${display.id}`} renderIcon={Launch}>Open fullscreen player</CarbonLink>}
            </div>
          </Tile>
          <div className="sg-detail__tabs"><Tabs>
            <TabList aria-label="Display sections" contained>
              <Tab>Playback</Tab><Tab>Health</Tab><Tab>Settings</Tab>
            </TabList>
            <TabPanels>
              <TabPanel><PlaybackTab display={display} playback={playback} /></TabPanel>
              <TabPanel><HealthTab display={display} now={now} /></TabPanel>
              <TabPanel><DisplaySettingsTab key={display.id} display={display} /></TabPanel>
            </TabPanels>
          </Tabs></div>
        </div>
      </div>
      {renaming && <RenameModal title="Rename display" label="Name" initial={display.name} onClose={() => setRenaming(false)} onSave={(value) => signage.updateDisplaySettings(display.id, { name: value, location: display.location, orientation: display.orientation, resolution: display.resolution, outside: display.outside })} />}
      {announcing && <AnnouncementModal display={display} onClose={() => setAnnouncing(false)} />}
      <DestructiveActionDialog open={confirm === 'revoke'} title="Revoke display" confirmLabel="Revoke" onClose={() => setConfirm(null)} onConfirm={() => { signage.revokeDisplay(display.id); setConfirm(null); store.notify({ kind: 'success', title: 'Display revoked', subtitle: 'Its credential no longer works.' }); }}>
        <p>{display.name} stops receiving content immediately and shows the pairing screen again. Pair it again to reuse the screen.</p>
      </DestructiveActionDialog>
      <DestructiveActionDialog open={confirm === 'delete'} title="Delete display" confirmLabel="Delete" onClose={() => setConfirm(null)} onConfirm={() => { signage.deleteDisplay(display.id); setConfirm(null); navigate('/signage'); store.notify({ kind: 'success', title: 'Display deleted' }); }}>
        <p>This removes {display.name} and its publication history. This cannot be undone.</p>
      </DestructiveActionDialog>
    </PageShell>
  );
}
