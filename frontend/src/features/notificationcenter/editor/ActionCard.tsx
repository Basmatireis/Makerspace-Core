import {
  Checkbox,
  IconButton,
  Link as CarbonLink,
  ListItem,
  MultiSelect,
  NumberInput,
  RadioTile,
  Select,
  SelectItem,
  Tag,
  TextInput,
  Tile,
  TileGroup,
  UnorderedList,
} from '@carbon/react';
import { Notification, TrashCan } from '@carbon/icons-react';
import type {
  NotificationCatalog,
  NotificationRuleInAppOptions,
  NotificationRuleSignageShownOn,
} from '../../../api/generated/models';
import { Link } from 'react-router-dom';
import { useAllManagedDevices } from '../../devices/queries';
import { signagePaths } from '../../signage/paths';
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
  /** Where the saved rule's notices show; absent for an unsaved rule. */
  signageShownOn?: NotificationRuleSignageShownOn;
  /** Whether the "Shown on" names link to the signage pages (the viewer can read signage). */
  signageLinks?: boolean;
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
      <div className="nc-fallback">
        <Checkbox
          id={`${id}-fallback`}
          labelText="If it has not reached someone after"
          checked={options.emailFallbackMinutes != null}
          onChange={(_event, { checked }) => set({ emailFallbackMinutes: checked ? 5 : null })}
        />
        <div className="nc-fallback__minutes">
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
        </div>
        <span>min, send it by e-mail instead</span>
      </div>
    </div>
  );
}

function DisplayTargets({
  id,
  action,
  signageShownOn,
  signageLinks,
  onChange,
}: Pick<Props, 'id' | 'action' | 'signageShownOn' | 'signageLinks' | 'onChange'>) {
  const target = action.signage ?? { durationMinutes: 15, tone: 'warning' };
  return (
    <>
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
      <ShownOn id={id} shownOn={signageShownOn} links={signageLinks ?? false} />
    </>
  );
}

/**
 * Displays and groups choose the rules they show themselves (Signage › Displays), so the rule only lists them, as
 * saved: removing the signage action in the editor shows here only after saving.
 */
function ShownOn({ id, shownOn, links }: { id: string; shownOn?: NotificationRuleSignageShownOn; links: boolean }) {
  if (!shownOn)
    return (
      <p className="nc-note">
        Displays and display groups choose which rules they show. Once the rule is saved, signage managers can select it
        under Signage › Displays.
      </p>
    );
  const targets = [
    ...shownOn.displays.map((target) => ({ ...target, to: signagePaths.display(target.id), group: false })),
    ...shownOn.groups.map((target) => ({ ...target, to: signagePaths.group(target.id), group: true })),
  ];
  return (
    <div>
      <h4 id={`${id}-shown-on`} className="cds--label">
        Shown on
      </h4>
      {targets.length === 0 ? (
        <p className="nc-note">
          No display shows this rule's notices yet. Signage managers choose them under Signage › Displays.
        </p>
      ) : (
        <UnorderedList aria-labelledby={`${id}-shown-on`}>
          {targets.map((target) => (
            <ListItem key={target.id}>
              {links ? (
                <CarbonLink as={Link} to={target.to}>
                  {target.name}
                </CarbonLink>
              ) : (
                target.name
              )}
              {target.group ? ' (group)' : ''}
              {target.allRules ? ' (all notices)' : ''}
            </ListItem>
          ))}
        </UnorderedList>
      )}
    </div>
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
  const {
    id,
    action,
    catalog,
    definition,
    lookup,
    showDelay,
    personal,
    signageShownOn,
    signageLinks,
    acknowledgeStops,
    onChange,
    onRemove,
  } = props;
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
        {action.channel === 'signage' && (
          <DisplayTargets
            id={id}
            action={action}
            signageShownOn={signageShownOn}
            signageLinks={signageLinks}
            onChange={onChange}
          />
        )}
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
