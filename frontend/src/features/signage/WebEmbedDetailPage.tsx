import './styles.scss';
import { useState } from 'react';
import {
  Button,
  InlineNotification,
  OverflowMenu,
  OverflowMenuItem,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tile,
} from '@carbon/react';
import { Upload } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import type { SignageWebEmbed } from '../../api/generated/models';
import { publishSignageWebEmbed } from '../../api/generated/signage/signage';
import { ApiError } from '../../api/http-client';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { usePublishedView } from './displayHooks';
import { PublishedScreen } from './displayParts';
import { useRefreshEmbed, useUpdateEmbed } from './embedMutations';
import { describePendingChange, errorMessage, isStaleWrite, orientationOf, pluralize } from './helpers';
import { signagePaths } from './paths';
import { PlaybackTab } from './PlaybackTab';
import { embedQuery, groupQuery, signageKeys } from './queries';
import { EmbedExtraTags, EmbedStatusTag } from './webEmbedParts';
import { WebEmbedCodeTab } from './WebEmbedCodeTab';
import { WebEmbedContentSettings } from './WebEmbedContentTab';
import { WebEmbedDataTab } from './WebEmbedDataTab';
import { DeleteWebEmbedDialog } from './WebEmbedDialogs';
import { WebEmbedWebsitesTab } from './WebEmbedWebsitesTab';
import { lastLoaded } from './webEmbeds';

export function WebEmbedDetailPage() {
  const { embedId = '' } = useParams();
  const query = useQuery(embedQuery(embedId));
  const crumbs = [{ label: 'Signage' }, { label: 'Web embeds', to: signagePaths.embeds }];
  if (query.isPending)
    return (
      <PageShell title="Web embed" width="wide" breadcrumbs={crumbs}>
        <FullPageLoading label="Loading web embed" />
      </PageShell>
    );
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <PageShell title={missing ? 'Web embed not found' : 'Web embed'} width="wide" breadcrumbs={crumbs}>
        {missing ? (
          <EmptyState title="This web embed does not exist" description="It may have been deleted." />
        ) : (
          <ErrorState
            message={errorMessage(query.error, 'The web embed could not be loaded.')}
            onRetry={() => void query.refetch()}
          />
        )}
      </PageShell>
    );
  }
  return <Detail embed={query.data} crumbs={crumbs} />;
}

function Detail({ embed, crumbs }: { embed: SignageWebEmbed; crumbs: { label: string; to?: string }[] }) {
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const refresh = useRefreshEmbed(embed.id);
  const update = useUpdateEmbed(embed.id);
  const canManage = hasPermission(user, PermissionId.signagemanage);
  const canPublish = hasPermission(user, PermissionId.signagepublish);
  const [deleting, setDeleting] = useState(false);
  const { preview, view, now } = usePublishedView(embed.id);
  const group = useQuery({ ...groupQuery(embed.groupId ?? ''), enabled: embed.groupId !== null }).data;
  const pending = embed.pendingChanges;
  const neverPublished = embed.publishedRevision === null;
  const upToDate = !neverPublished && pending.length === 0;

  const publish = useMutation({
    mutationFn: () => publishSignageWebEmbed(embed.id),
    onSuccess: async (updated) => {
      queryClient.setQueryData(signageKeys.embed(embed.id), updated);
      await refresh(signageKeys.rules(embed.id));
    },
    onError: (error) => {
      if (isStaleWrite(error)) void refresh(signageKeys.rules(embed.id));
    },
  });

  const actions = (
    <>
      {canManage && (
        <Button
          kind="tertiary"
          disabled={update.isPending}
          onClick={() => update.mutate({ expectedVersion: embed.version, enabled: !embed.enabled })}
        >
          {embed.enabled ? 'Turn off' : 'Turn on'}
        </Button>
      )}
      {canPublish && (
        <Button renderIcon={Upload} disabled={publish.isPending || upToDate} onClick={() => publish.mutate()}>
          {publish.isPending ? 'Publishing…' : neverPublished ? 'Publish' : 'Publish changes'}
        </Button>
      )}
      {canManage && (
        <div>
          <OverflowMenu flipped aria-label="Web embed actions" iconDescription="Web embed actions">
            <OverflowMenuItem itemText="Delete" isDelete onClick={() => setDeleting(true)} />
          </OverflowMenu>
        </div>
      )}
    </>
  );

  return (
    <PageShell
      title={embed.name}
      width="wide"
      breadcrumbs={crumbs}
      actions={actions}
      titleAdornment={<EmbedStatusTag embed={embed} />}
    >
      <div className="sg-stack">
        <div className="sg-inline">
          <EmbedExtraTags embed={embed} />
          <span className="sg-secondary">
            {lastLoaded(embed, now)} · {pluralize(embed.loadsToday, 'load')} today
          </span>
        </div>
        {embed.groupId !== null && (
          <p className="sg-secondary">
            Managed by group <Link to={signagePaths.group(embed.groupId)}>{group?.name ?? 'this group'}</Link>. Its
            rules and default scenes are edited there; publishing the group publishes this embed too.
          </p>
        )}
        {update.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title={embed.enabled ? 'Not turned off' : 'Not turned on'}
            subtitle={
              isStaleWrite(update.error)
                ? 'This web embed was changed somewhere else. It was refreshed; try again.'
                : errorMessage(update.error)
            }
          />
        )}
        {publish.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Not published"
            subtitle={
              isStaleWrite(publish.error)
                ? 'Something changed while publishing. The embed was refreshed; review the changes and publish again.'
                : errorMessage(publish.error)
            }
          />
        )}
        {neverPublished && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Not published yet"
            subtitle="Websites show “Nothing to show yet” until you publish its first revision."
          />
        )}
        {!neverPublished && pending.length > 0 && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title={pluralize(pending.length, 'unpublished change')}
            subtitle={`${pending.map(describePendingChange).join(' · ')}. Websites keep showing revision ${embed.publishedRevision} until you publish. Turning cameras or timelapses off applies right away.`}
          />
        )}
        {!embed.enabled && (
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="Turned off"
            subtitle="Websites show “This screen isn’t available” until you turn it on."
          />
        )}

        <div className="sg-detail">
          <Tile className="sg-detail__preview">
            <h2 className="sg-section-title">Preview as a website sees it</h2>
            {preview.isError && <p className="sg-secondary">The preview could not be loaded.</p>}
            {preview.isSuccess && !view && (
              <p className="sg-secondary">Nothing is published yet, so there is nothing to preview.</p>
            )}
            {view && (
              <>
                <div className={`sg-detail__frame sg-detail__frame--${orientationOf(embed.aspectRatio)}`}>
                  <PublishedScreen
                    view={view}
                    aspectRatio={embed.aspectRatio}
                    width={orientationOf(embed.aspectRatio) === 'portrait' ? '14rem' : '100%'}
                  />
                </div>
                <div className="sg-now">
                  <p>
                    Now showing <strong>{view.scene?.name ?? '—'}</strong>
                    {' — '}
                    <span className="sg-secondary">{view.result.reason}</span>
                  </p>
                  <p className="sg-secondary">
                    The preview shows what the last publication plays. Cameras and timelapses appear only where the
                    embed allows them.
                  </p>
                </div>
              </>
            )}
          </Tile>
          <div className="sg-detail__tabs">
            <Tabs>
              <TabList aria-label="Web embed sections" contained>
                <Tab>Content</Tab>
                <Tab>Websites</Tab>
                <Tab>Data shown</Tab>
                <Tab>Embed code</Tab>
              </TabList>
              <TabPanels>
                <TabPanel>
                  <div className="sg-stack">
                    {canManage && <WebEmbedContentSettings key={embed.id} embed={embed} />}
                    <PlaybackTab
                      owner={{ kind: 'embed', embed, canManage }}
                      activeRuleId={view?.result.ruleId ?? null}
                    />
                  </div>
                </TabPanel>
                <TabPanel>
                  <WebEmbedWebsitesTab embed={embed} canManage={canManage} />
                </TabPanel>
                <TabPanel>
                  <WebEmbedDataTab embed={embed} canManage={canManage} />
                </TabPanel>
                <TabPanel>
                  <WebEmbedCodeTab embed={embed} canManage={canManage} />
                </TabPanel>
              </TabPanels>
            </Tabs>
          </div>
        </div>
      </div>
      {deleting && <DeleteWebEmbedDialog embed={embed} onClose={() => setDeleting(false)} />}
    </PageShell>
  );
}
