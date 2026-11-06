import {
  Checkbox,
  IconButton,
  MultiSelect,
  NumberInput,
  RadioTile,
  Select,
  SelectItem,
  Tag,
  TextInput,
  Tile,
  TileGroup,
} from '@carbon/react';
import { Notification, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { NotificationCatalog, NotificationRuleInAppOptions } from '../../../api/generated/models';
import { useAllManagedDevices } from '../../devices/queries';
import { displaysQuery } from '../../signage/queries';
import {
  appearances,
  buttonKinds,
  channelLabel,
  delayOptions,
  levels,
  placeholderChoices,
  signageTones,
  tabletModes,
  toastSecondsOptions,
  type Action,
  type Definition,
} from '../ruleModel';
import type { NameLookup } from '../ruleText';
import { appearanceIcons, channelIcons, levelIcons } from './channelIcons';
import { MessageFields } from './MessageFields';
import { RecipientPicker } from './RecipientPicker';

type Props = {
  id: string;
  action: Action;
  catalog: NotificationCatalog;
  definition: Definition;
  lookup: NameLookup;
  /** Escalation steps are timed by their step, so they have no delay of their own. */
  showDelay: boolean;
  /** A subscription's recipient is always its owner. */
  personal?: boolean;
  acknowledgeStops: boolean;
  onChange: (next: Action) => void;
  onRemove: () => void;
};

type Option = { id: string; label: string };

function InAppOptions({
  id,
  options,
  acknowledgeStops,
  onChange,
}: {
  id: string;
  options: NotificationRuleInAppOptions;
  acknowledgeStops: boolean;
  onChange: (next: NotificationRuleInAppOptions) => void;
}) {
  const button = options.button ?? { kind: 'none' };
  const loud = options.appearance === 'banner' || options.appearance === 'dialog';
  const set = (patch: Partial<NotificationRuleInAppOptions>) => onChange({ ...options, ...patch });
  return (
    <div className="nc-inapp">
      <TileGroup
        legend="Appearance"
        name={`${id}-appearance`}
        valueSelected={options.appearance}
        onChange={(value) => set({ appearance: String(value) })}
        className="nc-appearance"
      >
        {appearances.map((appearance) => {
          const AppearanceIcon = appearanceIcons[appearance.value];
          return (
            <RadioTile key={appearance.value} id={`${id}-appearance-${appearance.value}`} value={appearance.value}>
              <span className="nc-appearance__title">
                <AppearanceIcon size={20} aria-hidden />
                <strong>{appearance.label}</strong>
              </span>
              <span className="nc-appearance__help">{appearance.help}</span>
            </RadioTile>
          );
        })}
      </TileGroup>
      <fieldset className="nc-levels">
        <legend className="cds--label">Level</legend>
        <div className="nc-levels__chips">
          {levels.map((level) => {
            const LevelIcon = levelIcons[level.value];
            return (
              <label key={level.value} className={`nc-level nc-k--${level.value}`}>
                <input
                  type="radio"
                  className="cds--visually-hidden"
                  name={`${id}-level`}
                  id={`${id}-level-${level.value}`}
                  value={level.value}
                  checked={options.level === level.value}
                  onChange={() => set({ level: level.value })}
                />
                <LevelIcon size={16} aria-hidden />
                {level.label}
              </label>
            );
          })}
        </div>
      </fieldset>
      {options.appearance === 'toast' && (
        <Select
          id={`${id}-toast`}
          labelText="Pop-up stays"
          value={String(options.toastSeconds ?? 10)}
          onChange={(event) =>
            set({ toastSeconds: Number(event.target.value) as NotificationRuleInAppOptions['toastSeconds'] })
          }
        >
          {toastSecondsOptions.map((option) => (
            <SelectItem key={option.value} value={String(option.value)} text={option.label} />
          ))}
        </Select>
      )}
      <div className="nc-row">
        <Select
          id={`${id}-button`}
          labelText="Button"
          helperText={
            button.kind === 'acknowledge' && !acknowledgeStops
              ? 'To let this button stop the escalation, choose “Someone acknowledges it” under If nobody reacts.'
              : undefined
          }
          value={button.kind}
          onChange={(event) => set({ button: { ...button, kind: event.target.value } })}
        >
          {buttonKinds.map((kind) => (
            <SelectItem key={kind.value} value={kind.value} text={kind.label} />
          ))}
        </Select>
        {button.kind !== 'none' && (
          <TextInput
            id={`${id}-button-label`}
            labelText="Button text"
            maxLength={40}
            value={button.label ?? ''}
            onChange={(event) => set({ button: { ...button, label: event.target.value } })}
          />
        )}
      </div>
      {button.kind === 'link' && (
        <TextInput
          id={`${id}-button-link`}
          labelText="Opens"
          helperText="{link}, a page of the app such as /open-days, or an https address."
          maxLength={500}
          value={button.link ?? ''}
          onChange={(event) => set({ button: { ...button, link: event.target.value } })}
        />
      )}
      {loud && button.kind !== 'none' && (
        <Checkbox
          id={`${id}-only-button`}
          labelText="Only the button closes it"
          helperText="No close icon; it stays until the button is pressed or the issue is resolved."
          checked={Boolean(options.onlyButtonCloses)}
          onChange={(_event, { checked }) => set({ onlyButtonCloses: checked })}
        />
      )}
      {options.appearance === 'dialog' && (
        <Checkbox
          id={`${id}-later`}
          labelText="Offer “Remind me later”"
          helperText="Hides the dialog for an hour; it then appears again."
          checked={Boolean(options.allowLater)}
          onChange={(_event, { checked }) => set({ allowLater: checked })}
        />
      )}
      <Checkbox
        id={`${id}-online`}
        labelText="Only to people who have the app open right now"
        helperText="Everyone else does not get it at all, not even later."
        checked={Boolean(options.onlineOnly)}
        onChange={(_event, { checked }) => set({ onlineOnly: checked })}
      />
      <div className="nc-row nc-row--inline">
        <Checkbox
          id={`${id}-fallback`}
          labelText="If it has not reached someone after"
          checked={options.emailFallbackMinutes != null}
          onChange={(_event, { checked }) => set({ emailFallbackMinutes: checked ? 5 : null })}
        />
        <NumberInput
          id={`${id}-fallback-minutes`}
          label="Minutes before the e-mail"
          hideLabel
          min={1}
          max={1440}
          disabled={options.emailFallbackMinutes == null}
          value={options.emailFallbackMinutes ?? 5}
          onChange={(_event, state) => set({ emailFallbackMinutes: Number(state.value) || 5 })}
        />
        <span>min, send it by e-mail instead</span>
      </div>
    </div>
  );
}

function DisplayTargets({ id, action, onChange }: Pick<Props, 'id' | 'action' | 'onChange'>) {
  const displays = useQuery(displaysQuery());
  const items: Option[] = (displays.data?.items ?? []).map((display) => ({ id: display.id, label: display.name }));
  const target = action.signage ?? { displayIds: [], durationMinutes: 15, tone: 'warning' };
  return (
    <>
      <MultiSelect<Option>
        id={`${id}-displays`}
        titleText="Show on"
        label="Choose displays"
        items={items}
        itemToString={(item) => item?.label ?? ''}
        selectedItems={items.filter((item) => target.displayIds.includes(item.id))}
        onChange={({ selectedItems }) =>
          onChange({ ...action, signage: { ...target, displayIds: (selectedItems ?? []).map((item) => item.id) } })
        }
      />
      <div className="nc-row">
        <NumberInput
          id={`${id}-duration`}
          label="For (minutes)"
          min={1}
          max={1440}
          value={target.durationMinutes}
          onChange={(_event, state) =>
            onChange({ ...action, signage: { ...target, durationMinutes: Number(state.value) || 1 } })
          }
        />
        <Select
          id={`${id}-tone`}
          labelText="Look"
          value={target.tone}
          onChange={(event) => onChange({ ...action, signage: { ...target, tone: event.target.value } })}
        >
          {signageTones.map((tone) => (
            <SelectItem key={tone.value} value={tone.value} text={tone.label} />
          ))}
        </Select>
      </div>
      <p className="nc-note">The notice lies over the running scene and disappears early once the issue is resolved.</p>
    </>
  );
}

function TabletTargets({ id, action, onChange }: Pick<Props, 'id' | 'action' | 'onChange'>) {
  const { devices } = useAllManagedDevices();
  const items: Option[] = (devices ?? []).map((device) => ({ id: device.id, label: device.name }));
  const target = action.tablet ?? { deviceIds: [], mode: 'banner', mustTap: true };
  return (
    <>
      <MultiSelect<Option>
        id={`${id}-devices`}
        titleText="On"
        label="Choose tablets"
        items={items}
        itemToString={(item) => item?.label ?? ''}
        selectedItems={items.filter((item) => target.deviceIds.includes(item.id))}
        onChange={({ selectedItems }) =>
          onChange({ ...action, tablet: { ...target, deviceIds: (selectedItems ?? []).map((item) => item.id) } })
        }
      />
      <div className="nc-row">
        <Select
          id={`${id}-tablet-mode`}
          labelText="Show it"
          value={target.mode}
          onChange={(event) => onChange({ ...action, tablet: { ...target, mode: event.target.value } })}
        >
          {tabletModes.map((mode) => (
            <SelectItem key={mode.value} value={mode.value} text={mode.label} />
          ))}
        </Select>
        <Checkbox
          id={`${id}-must-tap`}
          labelText="Must be tapped away"
          checked={Boolean(target.mustTap)}
          onChange={(_event, { checked }) => onChange({ ...action, tablet: { ...target, mustTap: checked } })}
        />
      </div>
    </>
  );
}

/** One action of the rule: a channel, who gets it, how it looks and what it says. */
export function ActionCard(props: Props) {
  const { id, action, catalog, definition, lookup, showDelay, personal, acknowledgeStops, onChange, onRemove } = props;
  const Icon = channelIcons[action.channel] ?? Notification;
  const people = action.channel === 'in_app' || action.channel === 'email';
  return (
    <Tile className="nc-action" aria-label={channelLabel(action.channel)}>
      <div className="nc-action__head">
        <span className="nc-action__name">
          <Icon size={16} />
          {channelLabel(action.channel)}
        </span>
        {showDelay && (
          <Select
            id={`${id}-delay`}
            labelText="When"
            hideLabel
            size="sm"
            value={String(action.delayMinutes ?? 0)}
            onChange={(event) => onChange({ ...action, delayMinutes: Number(event.target.value) })}
          >
            {delayOptions.map((option) => (
              <SelectItem key={option.value} value={String(option.value)} text={option.label} />
            ))}
          </Select>
        )}
        <IconButton
          kind="ghost"
          size="sm"
          label={`Remove ${channelLabel(action.channel)}`}
          align="left"
          onClick={onRemove}
        >
          <TrashCan />
        </IconButton>
      </div>
      <div className="nc-action__body">
        {people && personal && (
          <div className="nc-recipients">
            <span className="cds--label">To</span>
            <div className="nc-recipients__tags">
              <Tag type="gray" size="md">
                You
              </Tag>
            </div>
          </div>
        )}
        {people && !personal && (
          <RecipientPicker
            id={id}
            catalog={catalog}
            definition={definition}
            lookup={lookup}
            value={action.recipients}
            onChange={(recipients) => onChange({ ...action, recipients })}
          />
        )}
        {action.channel === 'in_app' && action.inApp && (
          <InAppOptions
            id={id}
            options={action.inApp}
            acknowledgeStops={acknowledgeStops}
            onChange={(inApp) => onChange({ ...action, inApp })}
          />
        )}
        {action.channel === 'signage' && <DisplayTargets id={id} action={action} onChange={onChange} />}
        {action.channel === 'tablet' && <TabletTargets id={id} action={action} onChange={onChange} />}
        <MessageFields
          id={id}
          channel={action.channel}
          title={action.title}
          body={action.body ?? ''}
          placeholders={placeholderChoices(catalog, definition)}
          onTitle={(title) => onChange({ ...action, title })}
          onBody={(body) => onChange({ ...action, body })}
        />
      </div>
    </Tile>
  );
}
