import { Button, InlineNotification, Tag, Tile, ToastNotification } from '@carbon/react';
import { Notification } from '@carbon/icons-react';
import type { ReactNode } from 'react';
import type { NotificationCatalog } from '../../../api/generated/models';
import { delayOptions, placeholderChoices, type Action, type Definition } from '../ruleModel';
import { channelIcons } from './channelIcons';
import { durationText, fillPlaceholders, splitPlaceholders, summaryText, type NameLookup } from '../ruleText';

type PreviewProps = {
  catalog: NotificationCatalog;
  definition: Definition;
  lookup: NameLookup;
};

/** Message text with `{placeholders}` highlighted; the example value is shown where the catalog has one. */
function Message({ text, examples }: { text: string; examples: Map<string, string> }) {
  return (
    <>
      {splitPlaceholders(text).map((part, index) =>
        part.kind === 'text' ? (
          <span key={index}>{part.value}</span>
        ) : (
          <mark key={index} className="nc-placeholder" title={`{${part.value}}`}>
            {examples.get(part.value) || `{${part.value}}`}
          </mark>
        ),
      )}
    </>
  );
}

const noticeKind = (level: string | undefined) =>
  level === 'success' || level === 'warning' || level === 'error' ? level : 'info';

function buttonLabel(action: Action): string {
  const button = action.inApp?.button;
  if (!button || button.kind === 'none') return '';
  return button.label || (button.kind === 'acknowledge' ? 'Acknowledge' : button.kind === 'ok' ? 'OK' : 'Open');
}

function InAppMock({ action, examples }: { action: Action; examples: Map<string, string> }) {
  const options = action.inApp;
  const kind = noticeKind(options?.level);
  const title = fillPlaceholders(action.title || '(no title yet)', examples);
  const body = action.body ? fillPlaceholders(action.body, examples) : undefined;
  const label = buttonLabel(action);
  const closable = !(options?.onlyButtonCloses && label) && options?.appearance !== 'dialog';
  const appearance = options?.appearance ?? 'toast';
  if (appearance === 'toast') {
    return (
      <ToastNotification
        kind={kind}
        lowContrast
        hideCloseButton={!closable}
        title={title}
        subtitle={body}
        caption={label || undefined}
        timeout={0}
      />
    );
  }
  if (appearance === 'banner') {
    return (
      <InlineNotification kind={kind} lowContrast hideCloseButton={!closable} title={title} subtitle={body}>
        {label && (
          <Button size="sm" kind="tertiary">
            {label}
          </Button>
        )}
      </InlineNotification>
    );
  }
  if (appearance === 'dialog') {
    return (
      <Tile className={`nc-mock-dialog nc-mock-dialog--${kind}`}>
        <h4>{title}</h4>
        {body && <p>{body}</p>}
        <div className="nc-mock-dialog__footer">
          {options?.allowLater && (
            <Button size="sm" kind="secondary">
              Remind me later
            </Button>
          )}
          <Button size="sm" kind="primary">
            {label || 'OK'}
          </Button>
        </div>
      </Tile>
    );
  }
  return (
    <Tile className="nc-mock-bell">
      <Notification size={16} />
      <div>
        <strong>{title}</strong>
        {body && <p>{body}</p>}
        <span className="nc-mock-bell__meta">Just now{label ? ` · ${label}` : ''}</span>
      </div>
    </Tile>
  );
}

function Mock({ action, examples }: { action: Action; examples: Map<string, string> }) {
  const title = action.title ? <Message text={action.title} examples={examples} /> : '(no title yet)';
  const body = action.body ? <Message text={action.body} examples={examples} /> : null;
  if (action.channel === 'in_app') {
    // A picture of the notification, not a live one: assistive technology should not announce it.
    return (
      <div aria-hidden="true">
        <InAppMock action={action} examples={examples} />
      </div>
    );
  }
  if (action.channel === 'email') {
    return (
      <Tile className="nc-mock-mail">
        <strong>{title}</strong>
        <p>{body}</p>
        <Button size="sm" kind="primary">
          Open in Makerspace Core
        </Button>
      </Tile>
    );
  }
  if (action.channel === 'signage') {
    return (
      <div className={`nc-mock-signage nc-mock-signage--${action.signage?.tone ?? 'info'}`}>
        <strong>{title}</strong>
        <span>{body}</span>
      </div>
    );
  }
  return (
    <Tile className="nc-mock-tablet">
      <strong>{title}</strong>
      {body && <p>{body}</p>}
      {action.tablet?.mustTap && (
        <Tag size="sm" type="gray">
          Tap to dismiss
        </Tag>
      )}
    </Tile>
  );
}

function Caption({ action, prefix }: { action: Action; prefix: string }): ReactNode {
  const Icon = channelIcons[action.channel] ?? Notification;
  const target =
    action.channel === 'signage'
      ? `${action.signage?.displayIds.length ?? 0} display(s) · ${action.signage?.durationMinutes ?? 0} min`
      : action.channel === 'tablet'
        ? `${action.tablet?.deviceIds.length ?? 0} tablet(s)`
        : `${action.recipients.length} recipient(s)`;
  return (
    <div className="nc-preview__caption">
      <Icon size={16} />
      <strong>{prefix}</strong>
      <span>{target}</span>
    </div>
  );
}

export function PreviewColumn({ catalog, definition, lookup }: PreviewProps) {
  const examples = new Map(placeholderChoices(catalog, definition).map((p) => [p.key, p.example] as const));
  const steps = definition.escalation?.steps ?? [];
  return (
    <aside className="nc-preview" aria-label="Preview">
      <Tile>
        <h3 className="nc-preview__heading">In plain words</h3>
        <p className="nc-plain" data-testid="plain-words">
          {summaryText(catalog, definition, lookup)}
        </p>
      </Tile>
      <Tile>
        <h3 className="nc-preview__heading">Example</h3>
        {definition.actions.length === 0 && <p className="nc-note">Add an action to see what people get.</p>}
        {definition.actions.map((action, index) => (
          <div key={`a${index}`} className="nc-preview__item">
            <Caption
              action={action}
              prefix={`${action.delayMinutes ? `${delayOptions.find((o) => o.value === action.delayMinutes)?.label ?? ''} · ` : ''}${action.channel === 'in_app' ? 'In-app' : action.channel === 'tablet' ? 'Tablet' : action.channel === 'email' ? 'E-mail' : 'Signage'}`}
            />
            <Mock action={action} examples={examples} />
          </div>
        ))}
        {steps.map((step, index) => (
          <div key={`s${index}`} className="nc-preview__item">
            <Caption action={step.action} prefix={`After ${durationText(step.after.value, step.after.unit)}`} />
            <Mock action={step.action} examples={examples} />
          </div>
        ))}
      </Tile>
    </aside>
  );
}
