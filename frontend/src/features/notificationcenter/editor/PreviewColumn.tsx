import { Button, Tag, Tile } from '@carbon/react';
import { Close, Notification } from '@carbon/icons-react';
import type { ReactNode } from 'react';
import type { NotificationCatalog } from '../../../api/generated/models';
import { collectionOf, delayOptions, placeholderChoices, type Action, type Definition } from '../ruleModel';
import { channelIcons, levelIcons, levelOf } from './channelIcons';
import { DryRunTile, EstimateTile, RecipientTile } from './DryRunPanels';
import { recipientsLine, type DryRunState } from './useDryRun';
import { durationText, fillPlaceholders, splitPlaceholders, summaryText, type NameLookup } from '../ruleText';

type PreviewProps = {
  catalog: NotificationCatalog;
  definition: Definition;
  lookup: NameLookup;
  dry: DryRunState;
  personal: boolean;
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

function buttonLabel(action: Action): string {
  const button = action.inApp?.button;
  if (!button || button.kind === 'none') return '';
  return button.label || (button.kind === 'acknowledge' ? 'Acknowledge' : button.kind === 'ok' ? 'OK' : 'Open');
}

/** One line under the miniature app that says how long the notification stays. */
function inAppNote(action: Action, hasButton: boolean): string {
  const options = action.inApp;
  const mustPress = Boolean(options?.onlyButtonCloses) && hasButton;
  switch (options?.appearance ?? 'toast') {
    case 'banner':
      return mustPress ? 'Stays on every page until the button is pressed.' : 'Stays on every page until it is closed.';
    case 'dialog':
      return mustPress ? 'Comes back on every page load until the button is pressed.' : 'Closes with the button.';
    case 'bell':
      return 'Only the badge on the bell goes up.';
    default: {
      const seconds = options?.toastSeconds ?? 10;
      return seconds > 0 ? `Disappears after ${seconds} s.` : 'Stays until it is closed.';
    }
  }
}

/**
 * The notification inside a miniature of the app, drawn where it really appears. It is a picture, so it uses plain
 * layout and theme tokens instead of live Carbon controls.
 */
function InAppMock({ action, examples }: { action: Action; examples: Map<string, string> }) {
  const options = action.inApp;
  const level = levelOf(options?.level);
  const LevelIcon = levelIcons[level];
  const title = fillPlaceholders(action.title || '(no title yet)', examples);
  const body = action.body ? fillPlaceholders(action.body, examples) : undefined;
  const label = buttonLabel(action);
  const appearance = options?.appearance ?? 'toast';
  const closable = !(options?.onlyButtonCloses && label) && appearance !== 'dialog';
  const close = closable && <Close size={12} className="nc-app__close" aria-hidden />;
  const caption = <p className="nc-preview__note">{inAppNote(action, Boolean(label))}</p>;
  if (appearance === 'bell') {
    return (
      <div className={`nc-k--${level}`}>
        <p className="nc-preview__note">In the bell list, the badge count goes up:</p>
        <div className="nc-bell-item">
          <LevelIcon size={16} className="nc-k__icon" aria-hidden />
          <div>
            <strong>{title}</strong>
            {body && <p>{body}</p>}
            <div className="nc-bell-item__foot">
              <span>Just now</span>
              {label && <span className="nc-bell-item__button">{label}</span>}
            </div>
          </div>
        </div>
      </div>
    );
  }
  const banner = (
    <div className="nc-app__banner">
      <LevelIcon size={16} className="nc-k__icon" aria-hidden />
      <div className="nc-app__text">
        <strong>{title}</strong>
        {body && <span> {body}</span>}
      </div>
      {label && <span className="nc-app__button">{label}</span>}
      {close}
    </div>
  );
  return (
    <div className={`nc-k--${level}`}>
      <div className="nc-app">
        <div className="nc-app__bar">
          <span className="nc-app__badge" />
        </div>
        {appearance === 'banner' && banner}
        <div className="nc-app__page">
          <i style={{ inlineSize: '40%' }} />
          <i />
          <i style={{ inlineSize: '85%' }} />
          <i style={{ inlineSize: '70%' }} />
        </div>
        {appearance === 'toast' && (
          <div className="nc-app__toast">
            <LevelIcon size={16} className="nc-k__icon" aria-hidden />
            <div className="nc-app__text">
              <strong>{title}</strong>
              {body && <span>{body}</span>}
              {label && <span className="nc-app__link">{label}</span>}
            </div>
            {close}
          </div>
        )}
        {appearance === 'dialog' && (
          <div className="nc-app__overlay">
            <div className="nc-app__dialog">
              <div className="nc-app__dialog-head">
                <LevelIcon size={16} className="nc-k__icon" aria-hidden />
                <strong>{title}</strong>
              </div>
              {body && <div className="nc-app__dialog-body">{body}</div>}
              <div className="nc-app__dialog-foot">
                {options?.allowLater && <span className="nc-app__dialog-secondary">Remind me later</span>}
                <span className="nc-app__dialog-primary">{label || 'OK'}</span>
              </div>
            </div>
          </div>
        )}
      </div>
      {caption}
    </div>
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

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

function Caption({ action, prefix, reach }: { action: Action; prefix: string; reach?: string }): ReactNode {
  const Icon = channelIcons[action.channel] ?? Notification;
  const target =
    action.channel === 'signage'
      ? `signage · ${action.signage?.durationMinutes ?? 0} min`
      : action.channel === 'tablet'
        ? plural(action.tablet?.deviceIds.length ?? 0, 'tablet', 'tablets')
        : plural(action.recipients.length, 'recipient', 'recipients');
  return (
    <div className="nc-preview__caption">
      <Icon size={16} />
      <strong>{prefix}</strong>
      <span>{target}</span>
      {reach && <span className="nc-preview__reach">· {reach}</span>}
    </div>
  );
}

export function PreviewColumn({ catalog, definition, lookup, dry, personal }: PreviewProps) {
  const examples = new Map(placeholderChoices(catalog, definition).map((p) => [p.key, p.example] as const));
  const steps = definition.escalation?.steps ?? [];
  const everyAction = [...definition.actions, ...steps.map((step) => step.action)];
  const collection = collectionOf(catalog, definition);
  return (
    <aside className="nc-preview" aria-label="Preview">
      <Tile>
        <h3 className="nc-preview__heading">In plain words</h3>
        <p className="nc-plain" data-testid="plain-words">
          {summaryText(catalog, definition, lookup)}
        </p>
      </Tile>
      {dry.data && <RecipientTile dry={dry.data} personal={personal} />}
      {dry.data && collection && dry.data.totalItems > 0 && <DryRunTile dry={dry.data} collection={collection} />}
      <Tile>
        <h3 className="nc-preview__heading">Example</h3>
        {definition.actions.length === 0 && <p className="nc-note">Add an action to see what people get.</p>}
        {definition.actions.map((action, index) => (
          <div key={`a${index}`} className="nc-preview__item">
            <Caption
              action={action}
              reach={recipientsLine(dry.data, everyAction, index)}
              prefix={`${action.delayMinutes ? `${delayOptions.find((o) => o.value === action.delayMinutes)?.label ?? ''} · ` : ''}${action.channel === 'in_app' ? 'In-app' : action.channel === 'tablet' ? 'Tablet' : action.channel === 'email' ? 'E-mail' : 'Signage'}`}
            />
            <Mock action={action} examples={examples} />
          </div>
        ))}
        {steps.map((step, index) => (
          <div key={`s${index}`} className="nc-preview__item">
            <Caption
              action={step.action}
              reach={recipientsLine(dry.data, everyAction, definition.actions.length + index)}
              prefix={`After ${durationText(step.after.value, step.after.unit)}`}
            />
            <Mock action={step.action} examples={examples} />
          </div>
        ))}
      </Tile>
      <EstimateTile dry={dry} />
    </aside>
  );
}
