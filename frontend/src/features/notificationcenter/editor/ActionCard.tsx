import {
  Checkbox,
  IconButton,
  Link as CarbonLink,
  ListItem,
  MultiSelect,
  NumberInput,
  RadioButton,
  RadioButtonGroup,
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
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { listManagedDeviceTypes } from '../../../api/generated/managed-devices/managed-devices';
import { keys } from '../../devices/components/deviceShared';
import { useAllManagedDevices } from '../../devices/queries';
import { signagePaths } from '../../signage/paths';
import {
  appearances,
  audienceMode,
  defaultLaterMinutes,
  maxLaterMinutes,
  withAudience,
  buttonKinds,
  channelLabel,
  delayOptions,
  levels,
  placeholderChoices,
  signageTones,
  tabletModes,
  toastSecondsOptions,
  type Action,
  type AudienceMode,
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
      <Audience id={id} options={options} onChange={onChange} />
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

/** Who gets an in-app notification: everyone, or only people with the app open (on certain devices, for a while). */
function Audience({
  id,
  options,
  onChange,
}: {
  id: string;
  options: NotificationRuleInAppOptions;
  onChange: (next: NotificationRuleInAppOptions) => void;
}) {
  const mode = audienceMode(options);
  const devices = options.devices;
  return (
    <>
      <RadioButtonGroup
        legendText="Who gets it"
        name={`${id}-audience`}
        orientation="vertical"
        valueSelected={mode}
        onChange={(value) => onChange(withAudience(options, value as AudienceMode))}
      >
        <RadioButton id={`${id}-audience-everyone`} value="everyone" labelText="Everyone, also later in the bell" />
        <RadioButton id={`${id}-audience-online`} value="online" labelText="Only people with the app open right now" />
        <RadioButton
          id={`${id}-audience-later`}
          value="later"
          labelText="People with the app open now, or who open it later"
        />
      </RadioButtonGroup>
      {mode === 'later' && (
        <div className="nc-later">
          <NumberInput
            id={`${id}-later-minutes`}
            label="Keep waiting for up to (minutes)"
            helperText="Whoever opens the app within this time still gets it, unless the cause is gone by then (for example the printer error was cleared)."
            min={1}
            max={maxLaterMinutes}
            value={options.laterMinutes ?? defaultLaterMinutes}
            onChange={(_event, state) => onChange({ ...options, laterMinutes: Number(state.value) || 1 })}
          />
        </div>
      )}
      {mode !== 'everyone' && (
        <>
          <Checkbox
            id={`${id}-devices-only`}
            labelText="Only on certain devices"
            helperText="People signed in on one of these devices or on a device of these types."
            checked={devices != null}
            onChange={(_event, { checked }) =>
              onChange({ ...options, devices: checked ? { deviceIds: [], deviceTypeIds: [] } : undefined })
            }
          />
          {devices && (
            <DeviceFilter id={id} devices={devices} onChange={(next) => onChange({ ...options, devices: next })} />
          )}
        </>
      )}
    </>
  );
}

function DeviceFilter({
  id,
  devices,
  onChange,
}: {
  id: string;
  devices: NonNullable<NotificationRuleInAppOptions['devices']>;
  onChange: (next: NonNullable<NotificationRuleInAppOptions['devices']>) => void;
}) {
  const { devices: managed } = useAllManagedDevices();
  const typesQuery = useQuery({ queryKey: keys.types, queryFn: ({ signal }) => listManagedDeviceTypes({ signal }) });
  const deviceItems: Option[] = (managed ?? []).map((device) => ({ id: device.id, label: device.name }));
  const typeItems: Option[] = (typesQuery.data?.items ?? []).map((type) => ({ id: type.id, label: type.name }));
  return (
    <div className="nc-row">
      <MultiSelect<Option>
        id={`${id}-filter-devices`}
        titleText="Devices"
        label="Choose devices"
        items={deviceItems}
        itemToString={(item) => item?.label ?? ''}
        selectedItems={deviceItems.filter((item) => devices.deviceIds.includes(item.id))}
        onChange={({ selectedItems }) =>
          onChange({ ...devices, deviceIds: (selectedItems ?? []).map((item) => item.id) })
        }
      />
      <MultiSelect<Option>
        id={`${id}-filter-types`}
        titleText="Device types"
        label="Choose device types"
        items={typeItems}
        itemToString={(item) => item?.label ?? ''}
        selectedItems={typeItems.filter((item) => devices.deviceTypeIds.includes(item.id))}
        onChange={({ selectedItems }) =>
          onChange({ ...devices, deviceTypeIds: (selectedItems ?? []).map((item) => item.id) })
        }
      />
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
