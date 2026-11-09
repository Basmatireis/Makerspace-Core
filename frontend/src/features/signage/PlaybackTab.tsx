import { useState } from 'react';
import {
  ActionableNotification,
  Button,
  ContainedList,
  ContainedListItem,
  IconButton,
  InlineNotification,
  Tag,
  Toggle,
} from '@carbon/react';
import { Add, ArrowDown, ArrowRight, ArrowUp, Edit, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { SignageRule, SignageRuleList, SignageSceneListItems } from '../../api/generated/models';
import { DeleteDialog, QueryBoundary } from './components';
import { DefaultScenesModal } from './DisplayDialogs';
import { useRuleNames } from './displayHooks';
import { DEFAULT_RULE_ID, describeCondition, loopSeconds } from './engine/playback';
import { errorMessage, formatLoop, isStaleWrite } from './helpers';
import { toPlaybackRule } from './publishedView';
import { signagePaths } from './paths';
import { ownerInfo, ownerRulesKey, ruleApi, useRefreshOwner, type PlaybackOwner } from './playbackOwner';
import { groupQuery, ownerRulesQuery, scenesQuery } from './queries';
import { RuleModal } from './RuleModal';

/**
 * Ordered "When … show …" rules, first match wins, with the default scenes fixed at the bottom. Works for a display or
 * a group. A display in a group shows the group's rules read-only: the group owns them.
 */
export function PlaybackTab({ owner, activeRuleId }: { owner: PlaybackOwner; activeRuleId: string | null }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const info = ownerInfo(owner);
  const key = { kind: info.kind, id: info.id };
  const refresh = useRefreshOwner(key);
  const rulesResult = useQuery(ownerRulesQuery(key));
  const scenes = useQuery(scenesQuery()).data?.items;
  const names = useRuleNames();
  const groupId = owner.kind === 'display' ? owner.display.groupId : null;
  const group = useQuery({ ...groupQuery(groupId ?? ''), enabled: groupId !== null });
  const [editing, setEditing] = useState<SignageRule | 'new' | null>(null);
  const [editingDefault, setEditingDefault] = useState(false);
  const [deleting, setDeleting] = useState<{ rule: SignageRule; position: number } | null>(null);
  const rules = rulesResult.data;
  const api = ruleApi(key);
  // A member has no list of its own; it plays its group's.
  const defaultScenes = groupId === null ? info.defaultScenes : (group.data?.defaultScenes ?? []);

  // Every rule write quotes the owner version and answers with the full list and the new version.
  const write = useMutation({
    mutationFn: (action: (version: number) => Promise<SignageRuleList>) => action(rules!.ownerVersion),
    onSuccess: async (list) => {
      queryClient.setQueryData(ownerRulesKey(key), list);
      await refresh();
    },
    onError: (error) => {
      if (isStaleWrite(error)) void refresh(ownerRulesKey(key));
    },
  });
  const move = (index: number, direction: -1 | 1) => {
    const ids = rules!.items.map((rule) => rule.id);
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    write.mutate((expectedVersion) => api.reorder({ expectedVersion, ruleIds: ids }));
  };
  // "Scene X" for a single item, "3 scenes · 45 s loop" for a list.
  const describeScenes = (items: SignageSceneListItems) => {
    if (items.length === 0) return '…';
    if (items.length === 1)
      return `Scene ${scenes?.find((item) => item.id === items[0].sceneId)?.name ?? (scenes ? 'Removed' : '…')}`;
    return `${items.length} scenes · ${formatLoop(loopSeconds(items))} loop`;
  };
  const revoked = owner.kind === 'display' && owner.display.status === 'revoked';
  const editable = owner.canManage && !revoked && groupId === null;

  return (
    <div className="sg-stack sg-tab">
      <div className="sg-tab__bar">
        <p className="sg-secondary">
          The first matching rule wins. “Active” shows what the {info.kind === 'group' ? 'group' : 'display'} runs now,
          from its last publication.
        </p>
        {editable && rules && (
          <Button kind="tertiary" size="md" renderIcon={Add} onClick={() => setEditing('new')}>
            Add rule
          </Button>
        )}
      </div>
      {groupId !== null && (
        <ActionableNotification
          inline
          role="status"
          kind="info"
          lowContrast
          hideCloseButton
          title="Playback is managed by the group"
          subtitle="Rules and default scenes of this display are those of its group. Change them there."
          actionButtonLabel={group.data ? `Open ${group.data.name}` : 'Open group'}
          onActionButtonClick={() => void navigate(signagePaths.group(groupId))}
        />
      )}
      {write.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title={isStaleWrite(write.error) ? 'The rules were changed somewhere else' : 'Rules not saved'}
          subtitle={
            isStaleWrite(write.error)
              ? 'The list was refreshed. Check it and repeat your change.'
              : errorMessage(write.error)
          }
        />
      )}
      <QueryBoundary query={rulesResult} label="rules">
        <ContainedList label="Playback rules" kind="on-page" isInset>
          {(rules?.items ?? []).map((rule, index, all) => (
            <ContainedListItem key={rule.id}>
              <div className={`sg-rule${rule.enabled ? '' : ' sg-rule--off'}`}>
                <span className="sg-rule__priority" aria-label={`Priority ${index + 1}`}>
                  {index + 1}
                </span>
                <div className="sg-rule__body">
                  <span>
                    <strong>When</strong> {describeCondition(toPlaybackRule(rule), names)}
                  </span>
                  <ArrowRight size={16} aria-hidden="true" />
                  <span>
                    <strong>{describeScenes(rule.scenes)}</strong>{' '}
                    <span className="sg-secondary">· min. {rule.minSeconds} s</span>
                  </span>
                </div>
                <div className="sg-rule__controls">
                  {activeRuleId === rule.id && (
                    <Tag type="green" size="sm">
                      Active
                    </Tag>
                  )}
                  {editable ? (
                    <>
                      <Toggle
                        id={`rule-toggle-${rule.id}`}
                        size="sm"
                        hideLabel
                        labelText={`Rule ${index + 1} enabled`}
                        labelA="Off"
                        labelB="On"
                        toggled={rule.enabled}
                        disabled={write.isPending}
                        onToggle={(checked) =>
                          write.mutate((expectedVersion) =>
                            api.setEnabled(rule.id, { expectedVersion, enabled: checked }),
                          )
                        }
                      />
                      <IconButton
                        label="Move up"
                        kind="ghost"
                        size="sm"
                        disabled={index === 0 || write.isPending}
                        onClick={() => move(index, -1)}
                      >
                        <ArrowUp />
                      </IconButton>
                      <IconButton
                        label="Move down"
                        kind="ghost"
                        size="sm"
                        disabled={index === all.length - 1 || write.isPending}
                        onClick={() => move(index, 1)}
                      >
                        <ArrowDown />
                      </IconButton>
                      <IconButton label="Edit rule" kind="ghost" size="sm" onClick={() => setEditing(rule)}>
                        <Edit />
                      </IconButton>
                      <IconButton
                        label="Delete rule"
                        kind="ghost"
                        size="sm"
                        onClick={() => setDeleting({ rule, position: index + 1 })}
                      >
                        <TrashCan />
                      </IconButton>
                    </>
                  ) : (
                    <Tag type="gray" size="sm">
                      {rule.enabled ? 'Enabled' : 'Disabled'}
                    </Tag>
                  )}
                </div>
              </div>
            </ContainedListItem>
          ))}
          <ContainedListItem>
            <div className="sg-rule">
              <span className="sg-rule__priority" aria-hidden="true">
                ∞
              </span>
              <div className="sg-rule__body">
                <strong>Otherwise</strong>
                <ArrowRight size={16} aria-hidden="true" />
                <strong>Default: {describeScenes(defaultScenes)}</strong>
              </div>
              <div className="sg-rule__controls">
                {activeRuleId === DEFAULT_RULE_ID && (
                  <Tag type="green" size="sm">
                    Active
                  </Tag>
                )}
                {editable && (
                  <IconButton
                    label="Edit default scenes"
                    kind="ghost"
                    size="sm"
                    onClick={() => setEditingDefault(true)}
                  >
                    <Edit />
                  </IconButton>
                )}
              </div>
            </div>
          </ContainedListItem>
        </ContainedList>
        {rules?.items.length === 0 && (
          <p className="sg-secondary">
            No rules yet. {info.kind === 'group' ? 'Its displays always show' : 'The display always shows'} the default
            scenes.
          </p>
        )}
      </QueryBoundary>
      {editing && rules && (
        <RuleModal
          owner={owner}
          version={rules.ownerVersion}
          rule={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {editingDefault && <DefaultScenesModal owner={owner} onClose={() => setEditingDefault(false)} />}
      {deleting && rules && (
        <DeleteDialog
          title={`Delete rule ${deleting.position}?`}
          noun="Rule"
          confirmLabel="Delete rule"
          onClose={() => setDeleting(null)}
          onDeleted={() => setDeleting(null)}
          remove={() => api.remove(deleting.rule.id, { expectedVersion: rules.ownerVersion })}
        >
          <p>
            “{describeCondition(toPlaybackRule(deleting.rule), names)}” stops applying once the{' '}
            {info.kind === 'group' ? 'group' : 'display'} is published.
          </p>
        </DeleteDialog>
      )}
    </div>
  );
}
