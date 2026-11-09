import './styles.scss';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ActionableNotification, Button, Modal, ToastNotification } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { NotificationAlert, NotificationUnreadCount } from '../../api/generated/models';
import {
  acknowledgeNotification,
  markNotificationRead,
  markNotificationSeen,
  postponeNotification,
} from '../../api/generated/notifications/notifications';
import { isExternalLink } from './openNotification';
import { notificationKeys } from './queries';

const LEVEL_LABELS = { info: 'Information', success: 'Success', warning: 'Warning', error: 'Error' } as const;
const DEFAULT_TOAST_SECONDS = 5;
const MAX_TOASTS = 3;
const MAX_BANNERS = 3;
const MAX_TOAST_BODY_LENGTH = 140;

function shorten(text: string): string {
  return text.length <= MAX_TOAST_BODY_LENGTH ? text : `${text.slice(0, MAX_TOAST_BODY_LENGTH - 1).trimEnd()}…`;
}

/** The text of the notification's button, or null without one. */
function buttonLabel(alert: NotificationAlert): string | null {
  switch (alert.button.kind) {
    case 'ok':
      return alert.button.label || 'OK';
    case 'acknowledge':
      return alert.button.label || 'Acknowledge';
    case 'link':
      return alert.button.label || 'Open';
    default:
      return null;
  }
}

const roleOf = (alert: NotificationAlert) =>
  alert.level === 'error' || alert.level === 'warning' ? 'alert' : 'status';

type Handlers = {
  /** The close icon, Escape or a plain OK: marks the notification read. */
  onClose: (alert: NotificationAlert) => void;
  /** The notification's own button. */
  onButton: (alert: NotificationAlert) => void;
  onLater: (alert: NotificationAlert) => void;
};

function Toast({ alert, handlers, onExpire }: { alert: NotificationAlert; handlers: Handlers; onExpire: () => void }) {
  const seconds = alert.toastSeconds ?? DEFAULT_TOAST_SECONDS;
  useEffect(() => {
    if (seconds <= 0) return undefined;
    const timer = window.setTimeout(onExpire, seconds * 1000);
    return () => window.clearTimeout(timer);
    // The timer starts when the toast appears; a new callback identity must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds]);
  const label = buttonLabel(alert);
  const common = {
    kind: alert.level,
    lowContrast: true,
    role: roleOf(alert),
    title: alert.title,
    subtitle: shorten(alert.body),
    onClose: () => {
      handlers.onClose(alert);
      return false;
    },
  } as const;
  if (!label) return <ToastNotification {...common} />;
  return (
    <ActionableNotification
      {...common}
      role={roleOf(alert)}
      hasFocus={false}
      actionButtonLabel={label}
      onActionButtonClick={() => handlers.onButton(alert)}
    />
  );
}

function Banner({ alert, handlers }: { alert: NotificationAlert; handlers: Handlers }) {
  const label = buttonLabel(alert);
  return (
    <ActionableNotification
      kind={alert.level}
      lowContrast
      inline
      hasFocus={false}
      role={roleOf(alert)}
      title={alert.title}
      subtitle={alert.body}
      actionButtonLabel={label ?? undefined}
      onActionButtonClick={() => handlers.onButton(alert)}
      hideCloseButton={alert.onlyButtonCloses}
      onClose={() => {
        handlers.onClose(alert);
        return false;
      }}
    >
      {alert.allowLater && (
        <Button kind="ghost" size="sm" onClick={() => handlers.onLater(alert)}>
          Remind me later
        </Button>
      )}
    </ActionableNotification>
  );
}

function Dialog({ alert, handlers }: { alert: NotificationAlert; handlers: Handlers }) {
  const label = buttonLabel(alert) ?? (alert.allowLater ? 'OK' : null);
  return (
    <Modal
      open
      size="sm"
      className={alert.onlyButtonCloses ? 'notification-dialog notification-dialog--locked' : 'notification-dialog'}
      modalLabel={LEVEL_LABELS[alert.level]}
      modalHeading={alert.title}
      danger={alert.level === 'error'}
      passiveModal={!label}
      primaryButtonText={label ?? ''}
      secondaryButtonText={alert.allowLater ? 'Remind me later' : undefined}
      preventCloseOnClickOutside={alert.onlyButtonCloses}
      onRequestClose={() => {
        if (!alert.onlyButtonCloses) handlers.onClose(alert);
      }}
      onRequestSubmit={() => handlers.onButton(alert)}
      onSecondarySubmit={() => handlers.onLater(alert)}
    >
      <p className="notification-dialog__body">{alert.body}</p>
    </Modal>
  );
}

type Views = {
  toasts: NotificationAlert[];
  known: Set<string>;
  hidden: Set<string>;
  poll: NotificationUnreadCount | null;
};

/**
 * Pop-ups, banners and dialogs. Pop-ups come from the notifications the last poll handed over for the first time;
 * banners and dialogs are the pinned ones, so they are back after a reload until they are closed, acknowledged or
 * postponed. One dialog shows at a time, the oldest first.
 */
export function AlertViews({ poll }: { poll: NotificationUnreadCount }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const refresh = () => queryClient.invalidateQueries({ queryKey: notificationKeys.all });
  const read = useMutation({ mutationFn: (id: string) => markNotificationRead(id), onSettled: refresh });
  const acknowledge = useMutation({ mutationFn: (id: string) => acknowledgeNotification(id), onSettled: refresh });
  const later = useMutation({ mutationFn: (id: string) => postponeNotification(id), onSettled: refresh });
  const seen = useMutation({ mutationFn: (id: string) => markNotificationSeen(id) });
  const reportSeen = seen.mutate;

  const [views, setViews] = useState<Views>({ toasts: [], known: new Set(), hidden: new Set(), poll: null });
  if (views.poll !== poll) {
    // A new poll answer: queue the pop-ups it brought and forget hidden notifications the server no longer lists.
    const added = poll.fresh.filter((alert) => alert.appearance === 'toast' && !views.known.has(alert.id));
    const listed = new Set([...poll.fresh, ...poll.pinned].map((alert) => alert.id));
    setViews({
      poll,
      toasts: [...views.toasts, ...added].slice(-MAX_TOASTS),
      known: new Set([...views.known, ...added.map((alert) => alert.id)]),
      hidden: new Set([...views.hidden].filter((id) => listed.has(id))),
    });
  }
  const hide = (id: string) =>
    setViews((current) => ({
      ...current,
      toasts: current.toasts.filter((alert) => alert.id !== id),
      hidden: new Set(current.hidden).add(id),
    }));

  const handlers: Handlers = {
    onClose: (alert) => {
      read.mutate(alert.id);
      hide(alert.id);
    },
    onButton: (alert) => {
      hide(alert.id);
      if (alert.button.kind === 'acknowledge') {
        acknowledge.mutate(alert.id);
        return;
      }
      read.mutate(alert.id);
      const link = alert.button.kind === 'link' ? alert.button.link : null;
      if (!link) return;
      if (isExternalLink(link)) window.open(link, '_blank', 'noopener,noreferrer');
      else void navigate(link);
    },
    onLater: (alert) => {
      later.mutate(alert.id);
      hide(alert.id);
    },
  };

  const pinned = new Map<string, NotificationAlert>();
  for (const alert of [...poll.pinned, ...poll.fresh]) {
    if (alert.appearance !== 'toast' && !views.hidden.has(alert.id)) pinned.set(alert.id, alert);
  }
  const waiting = [...pinned.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const banners = waiting.filter((alert) => alert.appearance === 'banner').slice(0, MAX_BANNERS);
  const dialog = waiting.find((alert) => alert.appearance === 'dialog');

  // What is on screen counts as seen, once the tab is visible; the server uses it to stop escalations.
  const shown = [...views.toasts, ...banners, ...(dialog ? [dialog] : [])].map((alert) => alert.id).join(',');
  const reported = useRef(new Set<string>());
  useEffect(() => {
    const report = () => {
      if (document.visibilityState !== 'visible') return;
      for (const id of shown.split(',').filter(Boolean)) {
        if (reported.current.has(id)) continue;
        reported.current.add(id);
        reportSeen(id);
      }
    };
    report();
    document.addEventListener('visibilitychange', report);
    return () => document.removeEventListener('visibilitychange', report);
  }, [shown, reportSeen]);

  return (
    <>
      {/* Pop-ups float over the whole shell, the bell panel included, so they leave the main area's stacking context. */}
      {views.toasts.length > 0 &&
        createPortal(
          <div className="app-toasts app-toasts--top" aria-live="polite">
            {views.toasts.map((alert) => (
              <Toast key={alert.id} alert={alert} handlers={handlers} onExpire={() => hide(alert.id)} />
            ))}
          </div>,
          document.body,
        )}
      {banners.length > 0 && (
        <div className="notification-banners">
          {banners.map((alert) => (
            <Banner key={alert.id} alert={alert} handlers={handlers} />
          ))}
        </div>
      )}
      {/* A direct child of the main area would be laid out as page content, so the dialog leaves it too. */}
      {dialog && createPortal(<Dialog key={dialog.id} alert={dialog} handlers={handlers} />, document.body)}
    </>
  );
}
