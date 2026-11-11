import { Tag, Toggle } from '@carbon/react';
import { Locked } from '@carbon/icons-react';
import type { NotificationReachingRule, NotificationSettings } from '../../api/generated/models';
import { DirectoryTable, type Column } from '../machinelogbook/shared/DirectoryTable';
import { useChangeRulePreference } from './mutations';

type Row = NotificationReachingRule & { id: string };
type ChannelId = 'in_app' | 'email';

const channelName: Record<ChannelId, string> = { in_app: 'In the app', email: 'By e-mail' };

/** One switch per channel. It starts from what the rule sends; "Added" and "Off" tell where the person differs. */
function ChannelCell({
  rule,
  channel,
  onChange,
}: {
  rule: Row;
  channel: ChannelId;
  /** Without a handler the choice is shown, not changed. */
  onChange?: (next: boolean) => void;
}) {
  const other: ChannelId = channel === 'in_app' ? 'email' : 'in_app';
  const on = rule.effectiveChannels.includes(channel);
  const inRule = rule.defaultChannels.includes(channel);
  // A required rule always keeps one way to reach the person.
  const lastRequired = rule.mandatory && on && !rule.effectiveChannels.includes(other);
  const state = on === inRule ? '' : on ? 'Added' : 'Off';
  return (
    <div className="mn-channel">
      <div className="mn-channel__switch">
        <Toggle
          id={`mn-${rule.ruleId}-${channel}`}
          size="sm"
          aria-label={`${rule.name}: ${channelName[channel].toLowerCase()}`}
          hideLabel
          labelA="Off"
          labelB="On"
          toggled={on}
          disabled={lastRequired || !onChange}
          onToggle={(next) => onChange?.(next)}
        />
        <span className="mn-channel__state">
          {lastRequired && <Locked size={16} aria-label="Required: keep at least one" />}
          {state}
        </span>
      </div>
      <span className="mn-sub">{inRule ? 'Sent by the rule' : 'Not in the rule'}</span>
    </div>
  );
}

type RulesViewProps = {
  settings: NotificationSettings;
  subject?: 'you' | 'person';
  /** Without a handler the channels are shown, not changed. */
  onChange?: (change: { ruleId: string; name: string; inApp: boolean; email: boolean }) => void;
};

export function ReachingRulesView({ settings, subject = 'you', onChange }: RulesViewProps) {
  const own = subject === 'you';
  const rows: Row[] = settings.rules.map((rule) => ({ ...rule, id: rule.ruleId }));
  const change = (rule: Row, channel: ChannelId, next: boolean) => {
    const inApp = channel === 'in_app' ? next : rule.effectiveChannels.includes('in_app');
    const email = channel === 'email' ? next : rule.effectiveChannels.includes('email');
    onChange?.({ ruleId: rule.ruleId, name: rule.name, inApp, email });
  };
  const blockedText = (rule: Row) => (
    <span className="mn-sub">
      {own ? "You don't get this" : "They don't get this"}: {rule.categoryName} is not allowed
      {own ? ' above' : ''}.
    </span>
  );
  const channelColumn = (channel: ChannelId): Column<Row> => ({
    key: channel,
    header: channelName[channel],
    render: (rule) =>
      rule.blockedByConsent ? (
        <span className="mn-dim">—</span>
      ) : (
        <ChannelCell
          rule={rule}
          channel={channel}
          onChange={onChange ? (next) => change(rule, channel, next) : undefined}
        />
      ),
  });
  const columns: Column<Row>[] = [
    {
      key: 'name',
      header: 'Rule',
      sortValue: (rule) => rule.name.toLowerCase(),
      render: (rule) => {
        const muted = !rule.mandatory && !rule.blockedByConsent && rule.effectiveChannels.length === 0;
        return (
          <div className={rule.blockedByConsent ? 'mn-dim' : undefined}>
            <div className="mn-rule-name">{rule.name}</div>
            <div className="mn-sub">
              {rule.triggerSummary ? `${rule.categoryName} · ${rule.triggerSummary}` : rule.categoryName}
            </div>
            {muted && (
              <Tag type="gray" size="sm">
                Muted for you
              </Tag>
            )}
            {rule.mandatory && !rule.blockedByConsent && (
              <Tag type="gray" size="sm" renderIcon={Locked}>
                Required: keep at least one
              </Tag>
            )}
          </div>
        );
      },
    },
    {
      key: 'why',
      header: own ? 'Why you get it' : 'Why they get it',
      narrow: true,
      render: (rule) =>
        rule.blockedByConsent ? (
          blockedText(rule)
        ) : (
          <ul className="mn-why">
            {rule.why.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ),
    },
    channelColumn('in_app'),
    channelColumn('email'),
  ];
  return (
    <section aria-labelledby="mn-rules-title">
      <div className="mn-section-head">
        <h2 id="mn-rules-title">{own ? 'Rules that can reach you' : 'Rules that reach this person'}</h2>
        <p>
          {own
            ? 'Turn a channel off to stop a rule from using it.'
            : 'Turn a channel off to stop a rule from using it for this person.'}{' '}
          Required rules always keep one.
        </p>
      </div>
      <DirectoryTable
        id="my-notification-rules"
        label={own ? 'Rules that can reach you' : 'Rules that reach this person'}
        columns={columns}
        rows={rows}
        totalCount={rows.length}
        searchText={(rule) => `${rule.name} ${rule.categoryName} ${rule.description}`}
        defaultSort={{ key: 'name', direction: 'ASC' }}
        empty={{
          title: own ? 'No rule reaches you right now' : 'No rule reaches this person right now',
          description: 'Rules that notify the person will be listed here.',
        }}
      />
    </section>
  );
}

/** The signed-in person's own rules: every change is saved at once. */
export function ReachingRulesTable({ settings }: { settings: NotificationSettings }) {
  const preference = useChangeRulePreference();
  return <ReachingRulesView settings={settings} onChange={(change) => preference.mutate(change)} />;
}
