import './styles.scss';
import { useState } from 'react';
import {
  Button,
  Link as CarbonLink,
  InlineNotification,
  OverflowMenu,
  OverflowMenuItem,
  Stack,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  Tag,
  TextInput,
  Tile,
} from '@carbon/react';
import { Add, Upload } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router-dom';
import type {
  SignageDisplay,
  SignageDisplayGroup,
  SignageDisplayList,
  SignageWebEmbed,
} from '../../api/generated/models';
import { publishSignageDisplayGroup } from '../../api/generated/signage/signage';
import { ApiError } from '../../api/http-client';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { RowActions } from '../../app/RowActions';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { aspectFieldsOf, aspectOfFields, type AspectFields } from './aspectFields';
import { AspectRatioFields } from './AspectRatioFields';
import { QueryBoundary } from './components';
import { displaysQuery, embedsQuery, groupQuery, signageKeys } from './queries';
import { EmbedStatusTag } from './webEmbedParts';
import { PublishedScreen, StatusTag } from './displayParts';
import { AddMembersModal, DeleteGroupDialog, RemoveMemberDialog } from './GroupDialogs';
import { useGroupPublishedView, useRefreshGroup, useUpdateGroup } from './groupMutations';
import {
  aspectLabel,
  describePendingChange,
  errorMessage,
  isStaleWrite,
  orientationOf,
  pluralize,
  sameRatio,
} from './helpers';
import { signagePaths } from './paths';
import { PlaybackTab } from './PlaybackTab';

export function GroupDetailPage() {
  const { groupId = '' } = useParams();
  const query = useQuery(groupQuery(groupId));
  const crumbs = [{ label: 'Signage' }, { label: 'Displays', to: signagePaths.displays }];
  if (query.isPending)
    return (
      <PageShell title="Group" width="wide" breadcrumbs={crumbs}>
        <FullPageLoading label="Loading group" />
      </PageShell>
    );
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <PageShell title={missing ? 'Group not found' : 'Group'} width="wide" breadcrumbs={crumbs}>
        {missing ? (
          <EmptyState title="This group does not exist" description="It may have been deleted." />
        ) : (
          <ErrorState
            message={errorMessage(query.error, 'The group could not be loaded.')}
            onRetry={() => void query.refetch()}
          />
        )}
      </PageShell>
    );
  }
  return <Detail group={query.data} crumbs={crumbs} />;
}

function Detail({ group, crumbs }: { group: SignageDisplayGroup; crumbs: { label: string; to?: string }[] }) {
  const queryClient = useQueryClient();
  const user = useCurrentUser();
  const refresh = useRefreshGroup(group.id);
  const canManage = hasPermission(user, PermissionId.signagemanage);
  const canPublish = hasPermission(user, PermissionId.signagepublish);
  const [deleting, setDeleting] = useState(false);
  const { preview, view, now } = useGroupPublishedView(group.id);
  const displaysResult = useQuery(displaysQuery());
  const members = (displaysResult.data?.items ?? []).filter((display) => display.groupId === group.id);
  const embedMembers = (useQuery(embedsQuery()).data?.items ?? []).filter((embed) => embed.groupId === group.id);
  const playable = members.filter((display) => display.status !== 'revoked');
  const pending = group.pendingChanges;
  const neverPublished = playable.some((display) => display.publishedRevision === null);
  const upToDate = pending.length === 0 && !neverPublished;

  const publish = useMutation({
    mutationFn: () => publishSignageDisplayGroup(group.id),
    onSuccess: async (updated) => {
      queryClient.setQueryData(signageKeys.group(group.id), updated);
      await refresh();
    },
    onError: (error) => {
      if (isStaleWrite(error)) void refresh();
    },
  });

  const actions = (
    <>
      {canPublish && (
        <Button
          renderIcon={Upload}
          disabled={publish.isPending || playable.length === 0 || upToDate}
          onClick={() => publish.mutate()}
        >
          {publish.isPending
            ? 'Publishing…'
            : pending.length > 0
              ? `Publish ${pluralize(pending.length, 'change')}`
              : 'Publish'}
        </Button>
      )}
      {canManage && (
        <div>
          <OverflowMenu flipped aria-label="Group actions" iconDescription="Group actions">
            <OverflowMenuItem itemText="Delete" isDelete onClick={() => setDeleting(true)} />
          </OverflowMenu>
        </div>
      )}
    </>
  );

  return (
    <PageShell
      title={group.name}
      width="wide"
      breadcrumbs={crumbs}
      actions={actions}
      titleAdornment={
        displaysResult.isSuccess && playable.length > 0 ? (
          upToDate ? (
            <Tag type="green">Up to date</Tag>
          ) : pending.length === 0 ? (
            <Tag type="warm-gray">Not published</Tag>
          ) : undefined
        ) : undefined
      }
    >
      <div className="sg-stack">
        {publish.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Not published"
            subtitle={
              isStaleWrite(publish.error)
                ? 'Something changed while publishing. The group was refreshed; review the changes and publish again.'
                : errorMessage(publish.error)
            }
          />
        )}
        {displaysResult.isSuccess && members.length === 0 && embedMembers.length === 0 && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="No members yet"
            subtitle="Add displays under Members. Publishing needs at least one display that can play."
          />
        )}
        {pending.length > 0 && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title={pluralize(pending.length, 'unpublished change')}
            subtitle={`${pending.map(describePendingChange).join(' · ')}. The members keep running their last publication until you publish.`}
          />
        )}
        {pending.length === 0 && neverPublished && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Not every member is published"
            subtitle="Members without a publication show “Waiting for content” until you publish the group."
          />
        )}

        <div className="sg-detail">
          <Tile className="sg-detail__preview">
            <h2 className="sg-section-title">Live preview</h2>
            {preview.isError && <p className="sg-secondary">The preview could not be loaded.</p>}
            {preview.isSuccess && !view && (
              <p className="sg-secondary">Nothing is published yet, so there is nothing to preview.</p>
            )}
            {view && (
              <>
                <div className={`sg-detail__frame sg-detail__frame--${orientationOf(group.aspectRatio)}`}>
                  <PublishedScreen
                    view={view}
                    aspectRatio={group.aspectRatio}
                    width={orientationOf(group.aspectRatio) === 'portrait' ? '14rem' : '100%'}
                  />
                </div>
                <div className="sg-now">
                  <p>
                    Now showing <strong>{view.scene?.name ?? '—'}</strong>
                    {' — '}
                    <span className="sg-secondary">{view.result.reason}</span>
                  </p>
                  <p className="sg-secondary">The latest publication of the first member that has one.</p>
                </div>
              </>
            )}
          </Tile>
          <div className="sg-detail__tabs">
            <Tabs>
              <TabList aria-label="Group sections" contained>
                <Tab>Playback</Tab>
                <Tab>Members</Tab>
                <Tab>Settings</Tab>
              </TabList>
              <TabPanels>
                <TabPanel>
                  <PlaybackTab owner={{ kind: 'group', group, canManage }} activeRuleId={view?.result.ruleId ?? null} />
                </TabPanel>
                <TabPanel>
                  <MembersTab
                    group={group}
                    displaysResult={displaysResult}
                    members={members}
                    embedMembers={embedMembers}
                    canManage={canManage}
                    now={now}
                  />
                </TabPanel>
                <TabPanel>
                  <GroupSettingsTab
                    key={group.id}
                    group={group}
                    canManage={canManage}
                    hasMembers={members.length + embedMembers.length > 0}
                  />
                </TabPanel>
              </TabPanels>
            </Tabs>
          </div>
        </div>
      </div>
      {deleting && <DeleteGroupDialog group={group} onClose={() => setDeleting(false)} />}
    </PageShell>
  );
}

function MembersTab({
  group,
  displaysResult,
  members,
  embedMembers,
  canManage,
  now,
}: {
  group: SignageDisplayGroup;
  displaysResult: UseQueryResult<SignageDisplayList>;
  members: SignageDisplay[];
  embedMembers: SignageWebEmbed[];
  canManage: boolean;
  now: number;
}) {
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<SignageDisplay | null>(null);
  const addButton = canManage ? (
    <Button kind="tertiary" size="md" renderIcon={Add} onClick={() => setAdding(true)}>
      Add display
    </Button>
  ) : undefined;
  return (
    <div className="sg-stack sg-tab">
      <div className="sg-tab__bar">
        <p className="sg-secondary">
          Members play the group’s rules and default scenes. Only displays with the aspect ratio{' '}
          {aspectLabel(group.aspectRatio)} can join.
        </p>
        {addButton}
      </div>
      <QueryBoundary query={displaysResult} label="members">
        {members.length === 0 && embedMembers.length === 0 ? (
          <p className="sg-secondary">This group has no members.</p>
        ) : (
          <TableContainer>
            <Table aria-label="Members" size="md">
              <TableHead>
                <TableRow>
                  <TableHeader>Name</TableHeader>
                  <TableHeader>Status</TableHeader>
                  {canManage && (
                    <TableHeader>
                      <span className="cds--visually-hidden">Actions</span>
                    </TableHeader>
                  )}
                </TableRow>
              </TableHead>
              <TableBody>
                {members.map((display) => (
                  <TableRow key={display.id}>
                    <TableCell>
                      <div className="sg-cell-stack">
                        <CarbonLink as={Link} to={signagePaths.display(display.id)}>
                          {display.name}
                        </CarbonLink>
                        {display.location && <span className="sg-secondary">{display.location}</span>}
                      </div>
                    </TableCell>
                    <TableCell>
                      <StatusTag display={display} now={now} />
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <RowActions label={`Actions for ${display.name}`}>
                          <Button kind="ghost" size="sm" onClick={() => setRemoving(display)}>
                            Remove
                          </Button>
                        </RowActions>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
                {embedMembers.map((embed) => (
                  <TableRow key={embed.id}>
                    <TableCell>
                      <div className="sg-cell-stack">
                        <CarbonLink as={Link} to={signagePaths.embed(embed.id)}>
                          {embed.name}
                        </CarbonLink>
                        <span className="sg-secondary">Web embed</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <EmbedStatusTag embed={embed} />
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <span className="sg-secondary">Leaves under Content on the embed</span>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </QueryBoundary>
      {adding && (
        <AddMembersModal group={group} displays={displaysResult.data?.items ?? []} onClose={() => setAdding(false)} />
      )}
      {removing && (
        <RemoveMemberDialog
          groupId={group.id}
          group={group.name}
          display={removing}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

type SettingsValues = AspectFields & { name: string };

const valuesOf = (group: SignageDisplayGroup): SettingsValues => ({
  name: group.name,
  ...aspectFieldsOf(group.aspectRatio),
});

function GroupSettingsTab({
  group,
  canManage,
  hasMembers,
}: {
  group: SignageDisplayGroup;
  canManage: boolean;
  hasMembers: boolean;
}) {
  const update = useUpdateGroup(group.id);
  const form = useForm<SettingsValues>({ defaultValues: valuesOf(group) });
  const { errors, isDirty } = form.formState;
  const [aspectPreset, aspectCustom] = form.watch(['aspectPreset', 'aspectCustom']);
  const ratioChanged = !sameRatio(aspectOfFields({ aspectPreset, aspectCustom }), group.aspectRatio);

  if (!canManage)
    return (
      <p className="sg-tab">
        {group.name} · {aspectLabel(group.aspectRatio)}
      </p>
    );

  const save = form.handleSubmit((values) =>
    update.mutate(
      {
        expectedVersion: group.version,
        name: values.name.trim(),
        aspectRatio: hasMembers ? group.aspectRatio : aspectOfFields(values),
        defaultScenes: group.defaultScenes,
      },
      { onSuccess: (saved) => form.reset(valuesOf(saved)) },
    ),
  );

  return (
    <Stack gap={5} className="sg-tab sg-settings">
      <TextInput
        id="group-settings-name"
        labelText="Name"
        maxLength={100}
        invalid={Boolean(errors.name)}
        invalidText="Give the group a name"
        {...form.register('name', { validate: (value) => value.trim() !== '' })}
      />
      {hasMembers ? (
        <TextInput
          id="group-settings-aspect-readonly"
          labelText="Aspect ratio"
          value={aspectLabel(group.aspectRatio)}
          readOnly
          helperText="The aspect ratio can only be changed while the group has no members. Remove the displays first."
        />
      ) : (
        <AspectRatioFields form={form} idPrefix="group-settings" />
      )}
      {!hasMembers && ratioChanged && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="The aspect ratio changes"
          subtitle="The default scenes and the scenes of every rule must already have the new aspect ratio; otherwise saving is refused. Edit them under Playback first."
        />
      )}
      {update.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Settings not saved"
          subtitle={
            isStaleWrite(update.error)
              ? 'This group was changed somewhere else and has been refreshed. Check the values and save again.'
              : errorMessage(update.error)
          }
        />
      )}
      {update.isSuccess && !isDirty && (
        <InlineNotification
          kind="success"
          lowContrast
          hideCloseButton
          title="Settings saved"
          subtitle="They reach the members with the next publication."
        />
      )}
      <div>
        <Button
          kind="primary"
          disabled={update.isPending || !isDirty}
          onClick={() => {
            void save();
          }}
        >
          {update.isPending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </Stack>
  );
}
