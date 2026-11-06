import { Button, Tile, Toggle } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { NotificationCatalog, NotificationRule } from '../../api/generated/models';
import {
  deleteOwnNotificationSubscription,
  updateOwnNotificationSubscription,
} from '../../api/generated/notification-rules/notification-rules';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { useNotify } from '../../app/toasts';
import { saveProblem } from '../notificationcenter/queries';
import { draftFromRule, toInput } from '../notificationcenter/ruleModel';
import { summaryText } from '../notificationcenter/ruleText';
import { personalSubscriptionPath } from '../notificationcenter/RuleEditorPage';
import { myNotificationKeys } from './queries';
import { startersFor } from './starters';

type Props = { catalog: NotificationCatalog; subscriptions: NotificationRule[] };

/** The person's own rules, ready-made starting points and the way to a new one. */
export function SubscriptionsSection({ catalog, subscriptions }: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const notify = useNotify();
  const [deleting, setDeleting] = useState<NotificationRule | null>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const starters = startersFor(catalog);

  const toggle = useMutation({
    mutationFn: (change: { rule: NotificationRule; enabled: boolean }) =>
      updateOwnNotificationSubscription(change.rule.id, {
        expectedVersion: change.rule.version,
        ...toInput({ ...draftFromRule(change.rule), enabled: change.enabled }),
      }),
    onSuccess: (_rule, change) =>
      notify({ kind: 'success', title: change.enabled ? 'Subscription on' : 'Subscription off' }),
    onError: (error) => notify({ kind: 'error', ...problemToast(error) }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: myNotificationKeys.subscriptions() }),
  });
  const remove = useMutation({
    mutationFn: (rule: NotificationRule) =>
      deleteOwnNotificationSubscription(rule.id, { expectedVersion: rule.version }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: myNotificationKeys.subscriptions() });
      setDeleting(null);
      notify({ kind: 'success', title: 'Subscription deleted' });
    },
  });
  const openNew = (state?: { starter: (typeof starters)[number]['draft'] }) =>
    navigate(`${personalSubscriptionPath}/new`, { state });

  return (
    <section aria-labelledby="mn-subscriptions-title">
      <div className="mn-section-head mn-section-head--action">
        <div>
          <h2 id="mn-subscriptions-title">Your subscriptions</h2>
          <p>
            Rules only for you. They can watch anything you&apos;re allowed to see and reach you in the app or by
            e-mail.
          </p>
        </div>
        <Button kind="primary" renderIcon={Add} onClick={() => openNew()}>
          New subscription
        </Button>
      </div>
      <div className="mn-cards">
        {subscriptions.map((rule) => (
          <Tile key={rule.id} className="mn-card">
            <div className="mn-card__top">
              <h3>{rule.name}</h3>
              <Toggle
                id={`mn-sub-${rule.id}`}
                size="sm"
                aria-label={`${rule.name} is ${rule.enabled ? 'on' : 'off'}`}
                hideLabel
                labelA="Off"
                labelB="On"
                toggled={rule.enabled}
                disabled={toggle.isPending}
                onToggle={(enabled) => toggle.mutate({ rule, enabled })}
              />
            </div>
            <p className="mn-card__text">{summaryText(catalog, rule.definition)}</p>
            <div className="mn-card__footer">
              <Button
                kind="ghost"
                size="sm"
                onClick={() => navigate(`${personalSubscriptionPath}/${rule.id}`)}
                aria-label={`Edit ${rule.name}`}
              >
                Edit
              </Button>
              <Button
                kind="ghost"
                size="sm"
                ref={deleting?.id === rule.id ? deleteButton : undefined}
                onClick={() => setDeleting(rule)}
                aria-label={`Delete ${rule.name}`}
              >
                Delete
              </Button>
            </div>
          </Tile>
        ))}
        {starters.map((starter) => (
          <Tile key={starter.key} className="mn-card mn-card--starter">
            <h3>{starter.name}</h3>
            <p className="mn-card__text">{starter.description}</p>
            <div className="mn-card__footer">
              <Button
                kind="tertiary"
                size="sm"
                renderIcon={Add}
                aria-label={`Start from: ${starter.name}`}
                onClick={() => openNew({ starter: starter.draft })}
              >
                Use this
              </Button>
            </div>
          </Tile>
        ))}
      </div>
      <DestructiveActionDialog
        open={deleting !== null}
        title={`Delete “${deleting?.name ?? ''}”?`}
        fate="permanent"
        confirmLabel="Delete subscription"
        pending={remove.isPending}
        error={remove.isError ? saveProblem(remove.error, 'Subscription').message : undefined}
        launcherButtonRef={deleteButton}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
      >
        <p>You won&apos;t get these messages any more.</p>
      </DestructiveActionDialog>
    </section>
  );
}

function problemToast(error: unknown) {
  const problem = saveProblem(error, 'Subscription');
  return { title: problem.title, subtitle: problem.message };
}
