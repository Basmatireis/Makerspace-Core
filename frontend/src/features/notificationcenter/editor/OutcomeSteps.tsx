import { Button, Checkbox, NumberInput, Select, SelectItem, Toggle, IconButton } from '@carbon/react';
import { Add, ArrowRight, Close, Settings, Upgrade } from '@carbon/icons-react';
import {
  contextOf,
  channels,
  durationUnits,
  newAction,
  personalChannels,
  resolutionChoices,
  throttleChoices,
  type Channel,
} from '../ruleModel';
import { ActionCard } from './ActionCard';
import { FlowStep, type StepProps } from './FlowStep';

function AddButtons({
  onAdd,
  prefix = '',
  personal = false,
  allowed,
}: {
  onAdd: (channel: Channel) => void;
  prefix?: string;
  personal?: boolean;
  /** The channels the rule's trigger allows; absent when every channel is. */
  allowed?: readonly string[];
}) {
  return (
    <div className="nc-actions-row">
      {channels
        .filter((channel) => !personal || personalChannels.includes(channel.id))
        .filter((channel) => !allowed || allowed.includes(channel.id))
        .map((channel) => (
          <Button key={channel.id} kind="ghost" size="sm" renderIcon={Add} onClick={() => onAdd(channel.id)}>
            {prefix}
            {channel.short}
          </Button>
        ))}
    </div>
  );
}

export function ThenStep(props: StepProps) {
  const { catalog, definition, lookup, edit, personal } = props;
  const ctx = contextOf(catalog, definition);
  const acknowledgeStops = definition.escalation?.stopWhen === 'acknowledged';
  return (
    <FlowStep icon={ArrowRight} eyebrow="Then" title={ctx.eachMode ? `Send, for each ${ctx.collection!.one}` : 'Send'}>
      {definition.actions.length === 0 && <p className="nc-note">Nothing is sent yet. Add at least one action.</p>}
      <div className="nc-actions">
        {definition.actions.map((action, index) => (
          <ActionCard
            key={index}
            id={`nc-action-${index}`}
            action={action}
            catalog={catalog}
            definition={definition}
            lookup={lookup}
            showDelay
            personal={personal}
            acknowledgeStops={acknowledgeStops}
            onChange={(next) =>
              edit((draft) => {
                draft.actions[index] = next;
              })
            }
            onRemove={() =>
              edit((draft) => {
                draft.actions.splice(index, 1);
              })
            }
          />
        ))}
      </div>
      <AddButtons
        personal={personal}
        allowed={ctx.trigger?.channels}
        onAdd={(channel) =>
          edit((draft) => {
            draft.actions.push(newAction(channel, personal));
          })
        }
      />
    </FlowStep>
  );
}

export function EscalationStep(props: StepProps) {
  const { catalog, definition, lookup, edit } = props;
  const escalation = definition.escalation;
  const resolutions = resolutionChoices(catalog, definition);
  const toggle = (
    <Toggle
      id="nc-escalation-on"
      size="sm"
      labelText="If nobody reacts"
      hideLabel
      labelA="Off"
      labelB="On"
      toggled={Boolean(escalation)}
      onToggle={(on) =>
        edit((draft) => {
          draft.escalation = on ? { stopWhen: resolutions[0]?.key ?? '', steps: [] } : null;
        })
      }
    />
  );
  if (!escalation) {
    return (
      <FlowStep icon={Upgrade} eyebrow="If nobody reacts" title="Escalation" right={toggle} off>
        <p className="nc-note">
          Send more messages when the issue is still open after a while, for example to the board after 20 minutes.
        </p>
      </FlowStep>
    );
  }
  return (
    <FlowStep icon={Upgrade} eyebrow="If nobody reacts" title="Escalation" right={toggle}>
      <Select
        id="nc-stop-when"
        labelText="Stop as soon as"
        value={escalation.stopWhen}
        onChange={(event) =>
          edit((draft) => {
            if (draft.escalation) draft.escalation.stopWhen = event.target.value;
          })
        }
      >
        {resolutions.map((resolution) => (
          <SelectItem key={resolution.key} value={resolution.key} text={resolution.label} />
        ))}
      </Select>
      <div className="nc-actions">
        {escalation.steps.map((step, index) => (
          <div key={index} className="nc-escstep">
            <div className="nc-escstep__when">
              <span>Step {index + 1}: if still open after</span>
              <NumberInput
                id={`nc-esc-${index}-after`}
                label="After"
                hideLabel
                min={1}
                value={step.after.value}
                onChange={(_event, state) =>
                  edit((draft) => {
                    if (draft.escalation) draft.escalation.steps[index].after.value = Number(state.value) || 1;
                  })
                }
              />
              <Select
                id={`nc-esc-${index}-unit`}
                labelText="Unit"
                hideLabel
                value={step.after.unit}
                onChange={(event) =>
                  edit((draft) => {
                    if (draft.escalation) draft.escalation.steps[index].after.unit = event.target.value;
                  })
                }
              >
                {durationUnits.map((unit) => (
                  <SelectItem key={unit.value} value={unit.value} text={unit.label} />
                ))}
              </Select>
              {index > 0 && <span className="nc-note">counted from the start</span>}
              <IconButton
                kind="ghost"
                size="sm"
                label="Remove step"
                align="left"
                onClick={() =>
                  edit((draft) => {
                    draft.escalation?.steps.splice(index, 1);
                  })
                }
              >
                <Close />
              </IconButton>
            </div>
            <ActionCard
              id={`nc-esc-${index}-action`}
              action={step.action}
              catalog={catalog}
              definition={definition}
              lookup={lookup}
              showDelay={false}
              acknowledgeStops={escalation.stopWhen === 'acknowledged'}
              onChange={(next) =>
                edit((draft) => {
                  if (draft.escalation) draft.escalation.steps[index].action = next;
                })
              }
              onRemove={() =>
                edit((draft) => {
                  draft.escalation?.steps.splice(index, 1);
                })
              }
            />
          </div>
        ))}
      </div>
      <AddButtons
        prefix="Step: "
        allowed={contextOf(catalog, definition).trigger?.channels}
        onAdd={(channel) =>
          edit((draft) => {
            const last = draft.escalation?.steps.at(-1)?.after;
            draft.escalation?.steps.push({
              after: last ? { value: last.value * 2, unit: last.unit } : { value: 20, unit: 'minutes' },
              action: newAction(channel),
            });
          })
        }
      />
    </FlowStep>
  );
}

export function LimitsStep({
  catalog,
  definition,
  edit,
  mandatory,
  onMandatory,
}: StepProps & {
  mandatory: boolean;
  /** Absent for a personal subscription: only central rules can be made unmutable. */
  onMandatory?: (next: boolean) => void;
}) {
  const throttle = definition.throttle;
  const subjects = throttleChoices(catalog, definition);
  return (
    <FlowStep icon={Settings} eyebrow="Limits" title="Options" off={!throttle && !mandatory}>
      <div className="nc-opts">
        <div className="nc-row nc-row--inline">
          <Checkbox
            id="nc-throttle-on"
            labelText="Fire at most once per"
            checked={Boolean(throttle)}
            onChange={(_event, { checked }) =>
              edit((draft) => {
                draft.throttle = checked ? { per: 'rule', every: { value: 1, unit: 'hours' } } : null;
              })
            }
          />
          <Select
            id="nc-throttle-per"
            labelText="Per"
            hideLabel
            disabled={!throttle}
            value={throttle?.per ?? 'rule'}
            onChange={(event) =>
              edit((draft) => {
                if (draft.throttle) draft.throttle.per = event.target.value;
              })
            }
          >
            {subjects.map((subject) => (
              <SelectItem key={subject.key} value={subject.key} text={subject.label} />
            ))}
          </Select>
          <span>every</span>
          <NumberInput
            id="nc-throttle-every"
            label="Every"
            hideLabel
            min={1}
            disabled={!throttle}
            value={throttle?.every.value ?? 1}
            onChange={(_event, state) =>
              edit((draft) => {
                if (draft.throttle) draft.throttle.every.value = Number(state.value) || 1;
              })
            }
          />
          <Select
            id="nc-throttle-unit"
            labelText="Unit"
            hideLabel
            disabled={!throttle}
            value={throttle?.every.unit ?? 'hours'}
            onChange={(event) =>
              edit((draft) => {
                if (draft.throttle) draft.throttle.every.unit = event.target.value;
              })
            }
          >
            {durationUnits.map((unit) => (
              <SelectItem key={unit.value} value={unit.value} text={unit.label} />
            ))}
          </Select>
        </div>
        {onMandatory && (
          <Checkbox
            id="nc-mandatory"
            labelText="People can't mute this rule"
            helperText="Use it for safety and duty messages. Everyone else can turn the rule off for themselves."
            checked={mandatory}
            onChange={(_event, { checked }) => onMandatory(checked)}
          />
        )}
      </div>
    </FlowStep>
  );
}
