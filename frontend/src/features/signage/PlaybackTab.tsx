import { useState } from 'react';
import { Button, ContainedList, ContainedListItem, IconButton, InlineNotification, Tag, Toggle } from '@carbon/react';
import { Add, ArrowDown, ArrowRight, ArrowUp, Edit, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SignageDisplay, SignageRule, SignageRuleList } from '../../api/generated/models';
import { deleteSignageRule, reorderSignageRules, setSignageRuleEnabled } from '../../api/generated/signage/signage';
import { DeleteDialog, QueryBoundary } from './components';
import { DefaultPlaylistModal } from './DisplayDialogs';
import { useRefreshDisplay } from './displayMutations';
import { useRuleNames } from './displayHooks';
import { DEFAULT_RULE_ID, describeCondition } from './engine/playback';
import { errorMessage, isStaleWrite } from './helpers';
import { toPlaybackRule } from './publishedView';
import { playlistsQuery, rulesQuery, scenesQuery, signageKeys } from './queries';
import { RuleModal } from './RuleModal';

/** Ordered "When … show …" rules, first match wins, with the default playlist fixed at the bottom. */
export function PlaybackTab({ display, canManage, activeRuleId }: { display: SignageDisplay; canManage: boolean; activeRuleId: string | null }) {
  const queryClient = useQueryClient();
  const refresh = useRefreshDisplay(display.id);
  const rulesResult = useQuery(rulesQuery(display.id));
  const scenes = useQuery(scenesQuery()).data?.items;
  const playlists = useQuery(playlistsQuery()).data?.items;
  const names = useRuleNames();
  const [editing, setEditing] = useState<SignageRule | 'new' | null>(null);
  const [editingDefault, setEditingDefault] = useState(false);
  const [deleting, setDeleting] = useState<{ rule: SignageRule; position: number } | null>(null);
  const rules = rulesResult.data;

  // Every rule write quotes the display version and answers with the full list and the new version.
  const write = useMutation({
    mutationFn: (action: (version: number) => Promise<SignageRuleList>) => action(rules!.displayVersion),
    onSuccess: async (list) => { queryClient.setQueryData(signageKeys.rules(display.id), list); await refresh(); },
    onError: (error) => { if (isStaleWrite(error)) void refresh(signageKeys.rules(display.id)); },
  });
  const move = (index: number, direction: -1 | 1) => {
    const ids = rules!.items.map((rule) => rule.id);
    [ids[index], ids[index + direction]] = [ids[index + direction], ids[index]];
    write.mutate((expectedVersion) => reorderSignageRules(display.id, { expectedVersion, ruleIds: ids }));
  };
  const targetName = (rule: SignageRule) => (rule.targetKind === 'scene' ? scenes?.find((item) => item.id === rule.targetId)?.name : playlists?.find((item) => item.id === rule.targetId)?.name) ?? 'Removed';
  const targetLabel = (rule: SignageRule) => `${rule.targetKind === 'scene' ? 'Scene' : 'Playlist'} ${targetName(rule)}`;
  const defaultName = playlists?.find((item) => item.id === display.defaultPlaylistId)?.name ?? '…';
  const editable = canManage && display.status !== 'revoked';

  return (
    <div className="sg-stack sg-tab">
      <div className="sg-tab__bar">
        <p className="sg-secondary">The first matching rule wins. “Active” shows what the display runs now, from its last publication.</p>
        {editable && rules && <Button kind="tertiary" size="md" renderIcon={Add} onClick={() => setEditing('new')}>Add rule</Button>}
      </div>
      {write.isError && (
        <InlineNotification kind="error" lowContrast hideCloseButton title={isStaleWrite(write.error) ? 'The rules were changed somewhere else' : 'Rules not saved'}
          subtitle={isStaleWrite(write.error) ? 'The list was refreshed. Check it and repeat your change.' : errorMessage(write.error)} />
      )}
      <QueryBoundary query={rulesResult} label="rules">
        <ContainedList label="Playback rules" kind="on-page" isInset>
          {(rules?.items ?? []).map((rule, index, all) => (
            <ContainedListItem key={rule.id}>
              <div className={`sg-rule${rule.enabled ? '' : ' sg-rule--off'}`}>
                <span className="sg-rule__priority" aria-label={`Priority ${index + 1}`}>{index + 1}</span>
                <div className="sg-rule__body">
                  <span><strong>When</strong> {describeCondition(toPlaybackRule(rule), names)}</span>
                  <ArrowRight size={16} aria-hidden="true" />
                  <span><strong>{targetLabel(rule)}</strong> <span className="sg-secondary">· min. {rule.minSeconds} s</span></span>
                </div>
                <div className="sg-rule__controls">
                  {activeRuleId === rule.id && <Tag type="green" size="sm">Active</Tag>}
                  {editable ? (
                    <>
                      <Toggle id={`rule-toggle-${rule.id}`} size="sm" hideLabel labelText={`Rule ${index + 1} enabled`} labelA="Off" labelB="On" toggled={rule.enabled} disabled={write.isPending}
                        onToggle={(checked) => write.mutate((expectedVersion) => setSignageRuleEnabled(display.id, rule.id, { expectedVersion, enabled: checked }))} />
                      <IconButton label="Move up" kind="ghost" size="sm" disabled={index === 0 || write.isPending} onClick={() => move(index, -1)}><ArrowUp /></IconButton>
                      <IconButton label="Move down" kind="ghost" size="sm" disabled={index === all.length - 1 || write.isPending} onClick={() => move(index, 1)}><ArrowDown /></IconButton>
                      <IconButton label="Edit rule" kind="ghost" size="sm" onClick={() => setEditing(rule)}><Edit /></IconButton>
                      <IconButton label="Delete rule" kind="ghost" size="sm" onClick={() => setDeleting({ rule, position: index + 1 })}><TrashCan /></IconButton>
                    </>
                  ) : <Tag type="gray" size="sm">{rule.enabled ? 'Enabled' : 'Disabled'}</Tag>}
                </div>
              </div>
            </ContainedListItem>
          ))}
          <ContainedListItem>
            <div className="sg-rule">
              <span className="sg-rule__priority" aria-hidden="true">∞</span>
              <div className="sg-rule__body">
                <strong>Otherwise</strong><ArrowRight size={16} aria-hidden="true" /><strong>Default playlist {defaultName}</strong>
              </div>
              <div className="sg-rule__controls">
                {activeRuleId === DEFAULT_RULE_ID && <Tag type="green" size="sm">Active</Tag>}
                {editable && <IconButton label="Edit default playlist" kind="ghost" size="sm" onClick={() => setEditingDefault(true)}><Edit /></IconButton>}
              </div>
            </div>
          </ContainedListItem>
        </ContainedList>
        {rules?.items.length === 0 && <p className="sg-secondary">No rules yet. The display always shows its default playlist.</p>}
      </QueryBoundary>
      {editing && rules && <RuleModal displayId={display.id} displayName={display.name} displayVersion={rules.displayVersion} rule={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {editingDefault && <DefaultPlaylistModal display={display} onClose={() => setEditingDefault(false)} />}
      {deleting && rules && (
        <DeleteDialog
          title={`Delete rule ${deleting.position}?`} noun="Rule" confirmLabel="Delete rule" onClose={() => setDeleting(null)} onDeleted={() => setDeleting(null)}
          remove={() => deleteSignageRule(display.id, deleting.rule.id, { expectedVersion: rules.displayVersion })}
        >
          <p>“{describeCondition(toPlaybackRule(deleting.rule), names)}” stops applying once the display is published.</p>
        </DeleteDialog>
      )}
    </div>
  );
}
