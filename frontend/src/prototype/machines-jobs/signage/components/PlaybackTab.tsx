import { useState } from 'react';
import { Button, ContainedList, ContainedListItem, IconButton, OverflowMenu, OverflowMenuItem, Tag, Toggle } from '@carbon/react';
import { Add, ArrowDown, ArrowRight, ArrowUp, Edit } from '@carbon/icons-react';
import { describeCondition } from '../engine';
import { targetName } from '../helpers';
import { RuleModal } from '../dialogs/RuleModal';
import { DefaultPlaylistModal } from '../dialogs/TextEditModals';
import { useSignage } from '../SignageContext';
import { useStore } from '../../store';
import type { Display, PlaybackResult, Rule } from '../types';

/** Ordered "When … show …" rules, first match wins, with the default playlist fixed at the bottom. */
export function PlaybackTab({ display, playback }: { display: Display; playback: PlaybackResult }) {
  const signage = useSignage();
  const store = useStore();
  const canManage = store.can('signage.manage') && !display.revoked;
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [editingDefault, setEditingDefault] = useState(false);
  const name = (target: Rule['target']) => targetName(target, signage.scenes, signage.playlists);
  const templateName = (id: string) => signage.announcementTemplates.find((item) => item.id === id)?.name ?? 'removed template';
  const defaultName = signage.playlists.find((item) => item.id === display.defaultPlaylistId)?.name ?? 'removed';

  return (
    <div className="mj-stack sg-tab">
      <div className="sg-tab__bar">
        <p className="mj-secondary">The first matching rule wins. “Active” reflects what the display runs now (the last publication).</p>
        {canManage && <Button kind="tertiary" size="md" renderIcon={Add} onClick={() => setEditing('new')}>Add rule</Button>}
      </div>
      <ContainedList label="Playback rules" kind="on-page" isInset>
        {display.rules.map((rule, index) => (
          <ContainedListItem key={rule.id}>
            <div className={`sg-rule${rule.enabled ? '' : ' sg-rule--off'}`}>
              <span className="sg-rule__priority" aria-label={`Priority ${index + 1}`}>{index + 1}</span>
              <div className="sg-rule__body">
                <span className="sg-rule__condition"><strong>When</strong> {describeCondition(rule.condition, templateName)}</span>
                <span className="sg-rule__arrow" aria-hidden="true"><ArrowRight size={16} /></span>
                <span className="sg-rule__target"><strong>{name(rule.target)}</strong> <span className="mj-secondary">· min. {rule.minSeconds} s</span></span>
              </div>
              <div className="sg-rule__controls">
                {playback.ruleId === rule.id && <Tag type="green" size="sm">Active</Tag>}
                {canManage ? (
                  <>
                    <Toggle id={`rule-toggle-${rule.id}`} size="sm" hideLabel labelText={`Rule ${index + 1} enabled`} labelA="Off" labelB="On" toggled={rule.enabled} onToggle={(checked) => signage.toggleRule(display.id, rule.id, checked)} />
                    <IconButton label="Move up" kind="ghost" size="sm" disabled={index === 0} onClick={() => signage.moveRule(display.id, rule.id, -1)}><ArrowUp /></IconButton>
                    <IconButton label="Move down" kind="ghost" size="sm" disabled={index === display.rules.length - 1} onClick={() => signage.moveRule(display.id, rule.id, 1)}><ArrowDown /></IconButton>
                    <OverflowMenu flipped size="sm" aria-label={`Actions for rule ${index + 1}`}>
                      <OverflowMenuItem itemText="Edit" onClick={() => setEditing(rule)} />
                      <OverflowMenuItem itemText="Delete" isDelete hasDivider onClick={() => signage.deleteRule(display.id, rule.id)} />
                    </OverflowMenu>
                  </>
                ) : <Tag type={rule.enabled ? 'gray' : 'cool-gray'} size="sm">{rule.enabled ? 'Enabled' : 'Disabled'}</Tag>}
              </div>
            </div>
          </ContainedListItem>
        ))}
        <ContainedListItem>
          <div className="sg-rule sg-rule--default">
            <span className="sg-rule__priority" aria-hidden="true">∞</span>
            <div className="sg-rule__body"><span className="sg-rule__condition"><strong>Otherwise</strong></span><span className="sg-rule__arrow" aria-hidden="true"><ArrowRight size={16} /></span><span className="sg-rule__target"><strong>Playlist {defaultName}</strong></span></div>
            <div className="sg-rule__controls">
              {playback.ruleId === 'default' && <Tag type="green" size="sm">Active</Tag>}
              {canManage && <IconButton label="Edit default playlist" kind="ghost" size="sm" onClick={() => setEditingDefault(true)}><Edit /></IconButton>}
            </div>
          </div>
        </ContainedListItem>
      </ContainedList>
      {display.rules.length === 0 && <p className="mj-secondary">No rules yet. The display always shows its default playlist.</p>}
      {editing && <RuleModal display={display} rule={editing === 'new' ? undefined : editing} onClose={() => setEditing(null)} />}
      {editingDefault && <DefaultPlaylistModal playlists={signage.playlists} current={display.defaultPlaylistId} onSave={(id) => signage.setDefaultPlaylist(display.id, id)} onClose={() => setEditingDefault(false)} />}
    </div>
  );
}
