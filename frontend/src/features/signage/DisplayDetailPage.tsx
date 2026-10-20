import './styles.scss';
import { useState } from 'react';
import { ActionableNotification, Button, InlineNotification, OverflowMenu, OverflowMenuItem, Tab, TabList, TabPanel, TabPanels, Tabs, Tag, Tile } from '@carbon/react';
import { Bullhorn, Upload } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import type { SignageDisplay } from '../../api/generated/models';
import { publishSignageDisplay, revokeSignageDisplay } from '../../api/generated/signage/signage';
import { ApiError } from '../../api/http-client';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { AnnouncementStartModal } from './AnnouncementStartModal';
import { DeleteDisplayDialog, RenameDisplayModal } from './DisplayDialogs';
import { useRefreshDisplay } from './displayMutations';
import { DisplaySettingsTab } from './DisplaySettingsTab';
import { usePublishedView, useRuleNames } from './displayHooks';
import { PublishedScreen, StatusTag } from './displayParts';
import { describePendingChange, errorMessage, isStaleWrite, orientationLabel, pluralize, resolutionLabel } from './helpers';
import { HealthTab } from './HealthTab';
import { PlaybackTab } from './PlaybackTab';
import { PlayerAddress } from './components';
import { signagePaths } from './paths';
import { displayQuery, rulesQuery, signageKeys } from './queries';
import { toPlaybackRule, type PublishedView } from './publishedView';
import { describeCondition } from './engine/playback';

export function DisplayDetailPage() {
  const { displayId = '' } = useParams();
  const query = useQuery(displayQuery(displayId));
  const crumbs = [{ label: 'Signage' }, { label: 'Displays', to: signagePaths.displays }];
  if (query.isPending) return <PageShell title="Display" width="wide" breadcrumbs={crumbs}><FullPageLoading label="Loading display" /></PageShell>;
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <PageShell title={missing ? 'Display not found' : 'Display'} width="wide" breadcrumbs={crumbs}>
        {missing ? <EmptyState title="This display does not exist" description="It may have been deleted." /> : <ErrorState message={errorMessage(query.error, 'The display could not be loaded.')} onRetry={() => void query.refetch()} />}
      </PageShell>
    );
  }
  return <Detail display={query.data} crumbs={crumbs} />;
}

/** "Display reports …" when the heartbeat disagrees with what the publication resolves to; empty when they agree or nothing was reported. */
function reportedDifference(display: SignageDisplay, view: PublishedView, describeRule: (id: string) => string | null, sceneName: (id: string) => string | undefined): string | null {
  if (display.status !== 'online' || display.currentRule === null) return null;
  if (display.reportedRevision !== null && display.publishedRevision !== null && display.reportedRevision !== display.publishedRevision) {
    return `Display reports: still running revision ${display.reportedRevision}; revision ${display.publishedRevision} has not been picked up yet.`;
  }
  const sameRule = display.currentRule === view.result.ruleId;
  const sameScene = display.currentSceneId === null || view.scene === null || display.currentSceneId === view.scene.id;
  if (sameRule && sameScene) return null;
  const rule = display.currentRule === 'default' ? 'the default playlist' : (describeRule(display.currentRule) ?? 'another rule');
  const scene = display.currentSceneId ? sceneName(display.currentSceneId) : undefined;
  return `Display reports: ${rule}${scene ? `, showing “${scene}”` : ''}. Its clock, minimum display times or live data may differ from this preview.`;
}

function Detail({ display, crumbs }: { display: SignageDisplay; crumbs: { label: string; to?: string }[] }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const refresh = useRefreshDisplay(display.id);
  const names = useRuleNames();
  const canManage = hasPermission(user, PermissionId.signagemanage);
  const revoked = display.status === 'revoked';
  const canPublish = hasPermission(user, PermissionId.signagepublish) && !revoked;
  const canOverride = hasPermission(user, PermissionId.signageoverride) && !revoked;
  const [renaming, setRenaming] = useState(false);
  const [announcing, setAnnouncing] = useState(false);
  const [confirm, setConfirm] = useState<'revoke' | 'delete' | null>(null);
  const { preview, view, now } = usePublishedView(display.id);
  const rules = useQuery(rulesQuery(display.id)).data;
  const pending = display.pendingChanges;
  const neverPublished = display.publishedRevision === null;
  const upToDate = !neverPublished && pending.length === 0;

  const publish = useMutation({
    mutationFn: () => publishSignageDisplay(display.id),
    onSuccess: async (updated) => { queryClient.setQueryData(signageKeys.display(display.id), updated); await refresh(signageKeys.rules(display.id)); },
    onError: (error) => { if (isStaleWrite(error)) void refresh(signageKeys.rules(display.id)); },
  });
  const revoke = useMutation({
    mutationFn: () => revokeSignageDisplay(display.id, { expectedVersion: display.version }),
    onSuccess: async (updated) => { queryClient.setQueryData(signageKeys.display(display.id), updated); setConfirm(null); await refresh(signageKeys.rules(display.id)); },
  });

  const sceneName = (id: string) => view?.manifest.scenes.find((scene) => scene.id === id)?.name;
  const describeRule = (id: string) => {
    const index = rules?.items.findIndex((rule) => rule.id === id) ?? -1;
    return index >= 0 && rules ? `rule ${index + 1} (${describeCondition(toPlaybackRule(rules.items[index]), names)})` : null;
  };
  const difference = view ? reportedDifference(display, view, describeRule, sceneName) : null;
  const activeAnnouncements = preview.data?.live.announcements ?? [];

  const actions = (
    <>
      {canOverride && <Button kind="tertiary" renderIcon={Bullhorn} onClick={() => setAnnouncing(true)}>Show announcement</Button>}
      {canPublish && !upToDate && (
        <Button renderIcon={Upload} disabled={publish.isPending} onClick={() => publish.mutate()}>
          {publish.isPending ? 'Publishing…' : neverPublished ? 'Publish' : `Publish ${pluralize(pending.length, 'change')}`}
        </Button>
      )}
      <div>
        <OverflowMenu flipped aria-label="Display actions" iconDescription="Display actions">
          {!revoked && <OverflowMenuItem itemText="Open player" onClick={() => window.open(signagePaths.player, '_blank', 'noopener')} />}
          {canManage && <OverflowMenuItem itemText="Rename" onClick={() => setRenaming(true)} />}
          {canManage && !revoked && <OverflowMenuItem itemText="Revoke" isDelete hasDivider onClick={() => setConfirm('revoke')} />}
          {canManage && <OverflowMenuItem itemText="Delete" isDelete hasDivider={revoked} onClick={() => setConfirm('delete')} />}
        </OverflowMenu>
      </div>
    </>
  );

  return (
    <PageShell
      title={display.name} width="wide" breadcrumbs={crumbs} actions={actions}
      description={[display.location, `${orientationLabel(display.orientation)} ${resolutionLabel(display.resolution)}`].filter(Boolean).join(' · ')}
      titleAdornment={revoked ? <Tag type="gray">Revoked</Tag> : upToDate ? <Tag type="green">Up to date</Tag> : neverPublished ? <Tag type="warm-gray">Not published</Tag> : undefined}
    >
      <div className="sg-stack">
        {publish.isError && (
          <InlineNotification kind="error" lowContrast hideCloseButton title="Not published"
            subtitle={isStaleWrite(publish.error) ? 'Something changed while publishing. The display was refreshed; review the changes and publish again.' : errorMessage(publish.error)} />
        )}
        {!revoked && neverPublished && <InlineNotification kind="info" lowContrast hideCloseButton title="Not published yet" subtitle="The display shows “Waiting for content” until you publish its first revision." />}
        {!revoked && !neverPublished && pending.length > 0 && (
          <InlineNotification kind="info" lowContrast hideCloseButton title={pluralize(pending.length, 'unpublished change')}
            subtitle={`${pending.map(describePendingChange).join(' · ')}. The display keeps running its last publication until you publish.`} />
        )}
        {activeAnnouncements.length > 0 && (
          <ActionableNotification inline lowContrast hideCloseButton kind="warning" title={`${pluralize(activeAnnouncements.length, 'announcement')} active`} subtitle={activeAnnouncements.map((item) => item.title).join(' · ')}
            actionButtonLabel="Manage" onActionButtonClick={() => navigate(signagePaths.announcements)} />
        )}

        <div className="sg-detail">
          <Tile className="sg-detail__preview">
            <h2 className="sg-section-title">Live preview</h2>
            {preview.isError && <p className="sg-secondary">The preview could not be loaded.</p>}
            {preview.isSuccess && !view && <p className="sg-secondary">Nothing is published yet, so there is nothing to preview.</p>}
            {view && (
              <>
                <div className={`sg-detail__frame sg-detail__frame--${display.orientation}`}>
                  <PublishedScreen view={view} orientation={display.orientation} resolution={display.resolution} width={display.orientation === 'portrait' ? '14rem' : '100%'} />
                </div>
                <div className="sg-now">
                  <p>
                    Now showing <strong>{view.scene?.name ?? view.targetName ?? '—'}</strong>
                    {view.targetKind === 'playlist' && view.scene && view.targetName ? <span className="sg-secondary"> in playlist {view.targetName}</span> : null}
                    {' — '}<span className="sg-secondary">{view.result.reason}</span>
                  </p>
                  {difference && <p className="sg-secondary">{difference}</p>}
                  <div className="sg-inline"><StatusTag display={display} now={now} /></div>
                </div>
              </>
            )}
            {!revoked && (
              <div className="sg-now sg-top-gap">
                <span className="sg-secondary">Player address. Open it in the kiosk browser on the screen.</span>
                <PlayerAddress />
              </div>
            )}
          </Tile>
          <div className="sg-detail__tabs">
            <Tabs>
              <TabList aria-label="Display sections" contained>
                <Tab>Playback</Tab><Tab>Health</Tab><Tab>Settings</Tab>
              </TabList>
              <TabPanels>
                <TabPanel><PlaybackTab display={display} canManage={canManage} activeRuleId={view?.result.ruleId ?? null} /></TabPanel>
                <TabPanel><HealthTab display={display} now={now} /></TabPanel>
                <TabPanel><DisplaySettingsTab key={display.id} display={display} canManage={canManage} /></TabPanel>
              </TabPanels>
            </Tabs>
          </div>
        </div>
      </div>
      {renaming && <RenameDisplayModal display={display} onClose={() => setRenaming(false)} />}
      {announcing && <AnnouncementStartModal display={display} onClose={() => setAnnouncing(false)} />}
      <DestructiveActionDialog open={confirm === 'revoke'} title="Revoke display" confirmLabel="Revoke" pending={revoke.isPending} error={revoke.isError ? errorMessage(revoke.error) : undefined} onConfirm={() => revoke.mutate()} onClose={() => setConfirm(null)}>
        <p>{display.name} stops receiving content immediately and shows the pairing screen again. Pair the screen again to reuse it.</p>
      </DestructiveActionDialog>
      {confirm === 'delete' && <DeleteDisplayDialog display={display} onClose={() => setConfirm(null)} />}
    </PageShell>
  );
}
