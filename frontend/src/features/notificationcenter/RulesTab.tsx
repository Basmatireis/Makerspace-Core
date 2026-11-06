import { Button, InlineNotification, Tag, Toggle } from '@carbon/react';
import {
  Add,
  Email,
  Locked,
  Notification,
  Repeat,
  Screen,
  TabletLandscape,
  Lightning,
  Time,
  TouchInteraction,
} from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ComponentType } from 'react';
import { useNavigate } from 'react-router-dom';
import type {
  NotificationCatalog,
  NotificationCategory,
  NotificationRule,
  NotificationRuleStats,
} from '../../api/generated/models';
import { updateNotificationRule } from '../../api/generated/notification-rules/notification-rules';
import { SectionSwitcher } from '../../app/SectionSwitcher';
import { formatDateTime } from '../../app/dateTime';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { DirectoryTable, type Column } from '../machinelogbook/shared/DirectoryTable';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { NewRuleModal } from './NewRuleModal';
import {
  catalogQuery,
  categoriesQuery,
  notificationCenterKeys,
  rulesQuery,
  saveProblem,
  useNameLookup,
} from './queries';
import { collectionOf, draftFromRule, toInput } from './ruleModel';
import { durationText, recipientLabel, triggerLabel, type NameLookup } from './ruleText';

const channelIcon: Record<string, ComponentType<{ size?: number | string }>> = {
  in_app: Notification,
  email: Email,
  signage: Screen,
  tablet: TabletLandscape,
};
const channelName: Record<string, string> = {
  in_app: 'In-app',
  email: 'E-mail',
  signage: 'Signage',
  tablet: 'Tablet',
};

const segments = [
  { id: 'all', label: 'All', test: () => true },
  { id: 'event', label: 'On events', test: (rule: NotificationRule) => rule.definition.trigger.type === 'event' },
  {
    id: 'schedule',
    label: 'On a schedule',
    test: (rule: NotificationRule) => rule.definition.trigger.type !== 'event',
  },
  { id: 'loop', label: 'For each', test: (rule: NotificationRule) => rule.definition.loop !== null },
  { id: 'off', label: 'Turned off', test: (rule: NotificationRule) => !rule.enabled },
] as const;

function allActions(rule: NotificationRule) {
  return [...rule.definition.actions, ...(rule.definition.escalation?.steps.map((step) => step.action) ?? [])];
}

function WhenCell({ rule, catalog }: { rule: NotificationRule; catalog: NotificationCatalog }) {
  const { trigger } = rule.definition;
  const Icon = trigger.type === 'event' ? Lightning : trigger.type === 'manual' ? TouchInteraction : Time;
  const area =
    trigger.type === 'event' ? catalog.triggers.find((candidate) => candidate.key === trigger.event)?.area : '';
  const collection = collectionOf(catalog, rule.definition);
  const loop = collection
    ? rule.definition.loop?.mode === 'each'
      ? `For each ${collection.one}`
      : `Summary of ${collection.plural}`
    : '';
  const sub = [area, loop].filter(Boolean).join(' · ');
  return (
    <div className="nc-cell">
      <Icon size={16} />
      <div className="mj-cell-stack">
        <span>{triggerLabel(catalog, rule.definition)}</span>
        {sub && (
          <span className="mj-secondary">
            {loop && <Repeat size={12} />} {sub}
          </span>
        )}
      </div>
    </div>
  );
}

function ThenCell({
  rule,
  catalog,
  lookup,
}: {
  rule: NotificationRule;
  catalog: NotificationCatalog;
  lookup: NameLookup;
}) {
  const actions = allActions(rule);
  const channels = [...new Set(actions.map((action) => action.channel))];
  const who = [
    ...new Set(
      actions.flatMap((action) =>
        action.recipients.map((key) => recipientLabel(key, catalog, rule.definition, lookup)),
      ),
    ),
  ];
  return (
    <div className="mj-cell-stack">
      <span className="nc-channels">
        {channels.map((channel) => {
          const Icon = channelIcon[channel] ?? Notification;
          return (
            <span key={channel} title={channelName[channel] ?? channel}>
              <Icon size={16} aria-label={channelName[channel] ?? channel} />
            </span>
          );
        })}
      </span>
      {who.length > 0 && (
        <span className="mj-secondary">
          {who.slice(0, 3).join(', ')}
          {who.length > 3 ? ` +${who.length - 3}` : ''}
        </span>
      )}
    </div>
  );
}

/** The last two weeks as small bars (a picture of the data, not a control) and the count of the last 30 days. */
function FiredCell({ stats }: { stats: NotificationRuleStats | null }) {
  if (!stats) return <span className="mj-secondary">—</span>;
  const days = stats.sparkline.slice(-14);
  const peak = Math.max(1, ...days);
  const total = days.reduce((sum, count) => sum + count, 0);
  return (
    <div className="mj-cell-stack">
      <svg
        className="nc-spark"
        viewBox={`0 0 ${days.length * 6} 24`}
        width={days.length * 6}
        height={24}
        role="img"
        aria-label={`${total} ${total === 1 ? 'time' : 'times'} in the last 14 days`}
      >
        {days.map((count, index) => {
          const height = count === 0 ? 1 : Math.max(3, Math.round((count / peak) * 24));
          return <rect key={index} x={index * 6} y={24 - height} width={4} height={height} />;
        })}
      </svg>
      <span className="mj-secondary">{stats.fired30} in 30 d</span>
    </div>
  );
}

export function RulesTab() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const canManage = hasPermission(currentUser, PermissionId.notification_rulesmanage);
  const rules = useQuery(rulesQuery());
  const catalog = useQuery(catalogQuery());
  const categories = useQuery(categoriesQuery());
  const lookup = useNameLookup([]);
  const [segment, setSegment] = useState<string>('all');
  const [creating, setCreating] = useState(false);

  const toggle = useMutation({
    mutationFn: ({ rule, enabled }: { rule: NotificationRule; enabled: boolean }) =>
      updateNotificationRule(rule.id, {
        expectedVersion: rule.version,
        ...toInput({ ...draftFromRule(rule), enabled }),
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: notificationCenterKeys.rules() }),
  });

  const loaded = {
    status:
      rules.status === 'success' && catalog.status === 'success' && categories.status === 'success'
        ? ('success' as const)
        : rules.status === 'error' || catalog.status === 'error' || categories.status === 'error'
          ? ('error' as const)
          : ('pending' as const),
    data: rules.data,
    refetch: () => {
      void catalog.refetch();
      void categories.refetch();
      return rules.refetch();
    },
  };

  return (
    <QueryBoundary query={loaded} errorMessage="The rules could not be loaded.">
      {(list) => {
        const cat = catalog.data!;
        const byCategory = new Map<string, NotificationCategory>(categories.data!.items.map((c) => [c.id, c]));
        const items = list.items;
        const visible = items.filter((rule) => segments.find((s) => s.id === segment)!.test(rule));
        const columns: Column<NotificationRule>[] = [
          {
            key: 'on',
            header: 'On',
            narrow: true,
            render: (rule) => (
              // Clicking the switch must not open the editor behind it.
              <div onClick={(event) => event.stopPropagation()}>
                <Toggle
                  id={`rule-on-${rule.id}`}
                  size="sm"
                  hideLabel
                  labelText={`${rule.name} is on`}
                  labelA="Off"
                  labelB="On"
                  toggled={rule.enabled}
                  disabled={!canManage || toggle.isPending}
                  onToggle={(enabled) => toggle.mutate({ rule, enabled })}
                />
              </div>
            ),
          },
          {
            key: 'name',
            header: 'Rule',
            sortValue: (rule) => rule.name,
            render: (rule) => {
              const category = rule.categoryId ? byCategory.get(rule.categoryId) : undefined;
              return (
                <div className="mj-cell-stack">
                  <strong>{rule.name}</strong>
                  {rule.description && <span className="mj-secondary">{rule.description}</span>}
                  <span className="nc-tags">
                    {category?.basis === 'consent' && (
                      <Tag size="sm" type="blue">
                        {category.name}
                      </Tag>
                    )}
                    {rule.mandatory && (
                      <Tag size="sm" type="gray" renderIcon={Locked}>
                        Can&apos;t be muted
                      </Tag>
                    )}
                  </span>
                </div>
              );
            },
          },
          { key: 'when', header: 'When', render: (rule) => <WhenCell rule={rule} catalog={cat} /> },
          { key: 'then', header: 'Then', render: (rule) => <ThenCell rule={rule} catalog={cat} lookup={lookup} /> },
          {
            key: 'escalation',
            header: 'If nobody reacts',
            render: (rule) => {
              const escalation = rule.definition.escalation;
              if (!escalation?.steps.length) return <span className="mj-secondary">—</span>;
              const first = escalation.steps[0].after;
              return (
                <Tag size="sm" type="purple">
                  {escalation.steps.length} step{escalation.steps.length > 1 ? 's' : ''}, first after{' '}
                  {durationText(first.value, first.unit)}
                </Tag>
              );
            },
          },
          {
            key: 'activity',
            header: 'Last 14 days',
            narrow: true,
            sortValue: (rule) => rule.stats?.fired30 ?? 0,
            firstDirection: 'DESC',
            render: (rule) => <FiredCell stats={rule.stats} />,
          },
          {
            key: 'lastFired',
            header: 'Last fired',
            narrow: true,
            sortValue: (rule) => rule.lastFiredAt ?? '',
            firstDirection: 'DESC',
            render: (rule) => (rule.lastFiredAt ? formatDateTime(rule.lastFiredAt) : 'Never'),
          },
        ];
        return (
          <>
            {toggle.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                title={saveProblem(toggle.error, 'Rule').title}
                subtitle={saveProblem(toggle.error, 'Rule').message}
                onCloseButtonClick={() => toggle.reset()}
              />
            )}
            <DirectoryTable
              id="notification-rules"
              label="Notification rules"
              columns={columns}
              rows={visible}
              totalCount={items.length}
              searchText={(rule) => `${rule.name} ${rule.description} ${triggerLabel(cat, rule.definition)}`}
              defaultSort={{ key: 'name', direction: 'ASC' }}
              onRowClick={(rule) => navigate(`/settings/notifications/rules/${rule.id}`)}
              switcher={
                <SectionSwitcher
                  label="Rules"
                  selected={segment}
                  onChange={setSegment}
                  sections={segments.map((s) => ({
                    id: s.id,
                    label: `${s.label} (${items.filter((rule) => s.test(rule)).length})`,
                  }))}
                />
              }
              toolbarAction={
                canManage ? (
                  <Button kind="primary" size="lg" renderIcon={Add} onClick={() => setCreating(true)}>
                    New rule
                  </Button>
                ) : undefined
              }
              empty={{
                title: 'No rules yet',
                description: 'Rules decide who is told what, when and how.',
              }}
            />
            <NewRuleModal open={creating} rules={items} onClose={() => setCreating(false)} />
          </>
        );
      }}
    </QueryBoundary>
  );
}
