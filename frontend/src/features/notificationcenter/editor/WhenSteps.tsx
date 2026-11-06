import {
  Checkbox,
  CheckboxGroup,
  ContentSwitcher,
  NumberInput,
  Select,
  SelectItem,
  SelectItemGroup,
  Switch,
  TimePicker,
  Toggle,
} from '@carbon/react';
import { Filter, Lightning, Repeat, Time, TouchInteraction } from '@carbon/icons-react';
import { blankDefinition, contextOf, emptySet, fieldGroups, weekdays, type RuleKind } from '../ruleModel';
import { ConditionList } from './ConditionList';
import { FlowStep, type StepProps } from './FlowStep';

const triggerTypes = ['event', 'schedule', 'manual'] as const;

export function WhenStep({ catalog, definition, edit }: StepProps) {
  const trigger = definition.trigger;
  const schedule = trigger.schedule ?? { repeat: 'daily' };
  const openDay = schedule.repeat === 'before_open_day' || schedule.repeat === 'after_open_day';
  const ctx = contextOf(catalog, definition);
  const areas = [...new Set(catalog.triggers.map((candidate) => candidate.area))];
  const setSchedule = (patch: Partial<typeof schedule>) =>
    edit(
      (draft) => {
        draft.trigger.schedule = { ...schedule, ...patch };
      },
      { prune: true },
    );

  const switcher = (
    <ContentSwitcher
      size="md"
      selectedIndex={Math.max(0, triggerTypes.indexOf(trigger.type as (typeof triggerTypes)[number]))}
      onChange={({ name }) => {
        const kind = name as RuleKind;
        if (kind === trigger.type) return;
        edit(
          (draft) => {
            draft.trigger = blankDefinition(catalog, kind).trigger;
          },
          { prune: true },
        );
      }}
    >
      <Switch name="event" text="Something happens" />
      <Switch name="schedule" text="On a schedule" />
      <Switch name="manual" text="By hand" />
    </ContentSwitcher>
  );

  return (
    <FlowStep
      icon={trigger.type === 'event' ? Lightning : trigger.type === 'manual' ? TouchInteraction : Time}
      eyebrow="When"
      title="Trigger"
      right={switcher}
    >
      {trigger.type === 'event' && (
        <Select
          id="nc-trigger-event"
          labelText="Event"
          helperText={ctx.trigger?.help}
          value={trigger.event ?? ''}
          onChange={(event) =>
            edit(
              (draft) => {
                draft.trigger.event = event.target.value;
              },
              { prune: true },
            )
          }
        >
          {areas.map((area) => (
            <SelectItemGroup key={area} label={area}>
              {catalog.triggers
                .filter((candidate) => candidate.area === area)
                .map((candidate) => (
                  <SelectItem key={candidate.key} value={candidate.key} text={candidate.label} />
                ))}
            </SelectItemGroup>
          ))}
        </Select>
      )}
      {trigger.type === 'manual' && (
        <p className="nc-note">
          The rule runs only when someone presses Run now. Together with For each this sends a one-off message, for
          example every person&apos;s current balance before the semester ends.
        </p>
      )}
      {trigger.type === 'schedule' && (
        <div className="nc-schedule">
          <Select
            id="nc-schedule-repeat"
            labelText="Repeat"
            value={schedule.repeat}
            onChange={(event) => {
              const repeat = event.target.value;
              setSchedule({
                repeat,
                time:
                  repeat === 'before_open_day' || repeat === 'after_open_day' ? undefined : (schedule.time ?? '09:00'),
                hours: repeat === 'before_open_day' || repeat === 'after_open_day' ? (schedule.hours ?? 2) : undefined,
                weekdays: repeat === 'weekly' ? (schedule.weekdays ?? ['mon']) : undefined,
                dayOfMonth: repeat === 'monthly' ? (schedule.dayOfMonth ?? 1) : undefined,
              });
            }}
          >
            {catalog.repeats.map((repeat) => (
              <SelectItem key={repeat.key} value={repeat.key} text={repeat.label} />
            ))}
          </Select>
          {openDay ? (
            <NumberInput
              id="nc-schedule-hours"
              label={schedule.repeat === 'before_open_day' ? 'Hours before it starts' : 'Hours after it ends'}
              min={0}
              max={72}
              value={schedule.hours ?? 0}
              onChange={(_event, state) => setSchedule({ hours: Number(state.value) || 0 })}
            />
          ) : (
            <TimePicker
              id="nc-schedule-time"
              labelText="At"
              placeholder="hh:mm"
              pattern="[0-2][0-9]:[0-5][0-9]"
              maxLength={5}
              value={schedule.time ?? ''}
              onChange={(event) => setSchedule({ time: event.target.value })}
            />
          )}
          {schedule.repeat === 'weekly' && (
            <CheckboxGroup legendText="On" orientation="horizontal">
              {weekdays.map((day) => (
                <Checkbox
                  key={day.value}
                  id={`nc-weekday-${day.value}`}
                  labelText={day.label}
                  checked={(schedule.weekdays ?? []).includes(day.value)}
                  onChange={(_event, { checked }) =>
                    setSchedule({
                      weekdays: weekdays
                        .map((entry) => entry.value as string)
                        .filter((value) => (value === day.value ? checked : (schedule.weekdays ?? []).includes(value))),
                    })
                  }
                />
              ))}
            </CheckboxGroup>
          )}
          {schedule.repeat === 'monthly' && (
            <NumberInput
              id="nc-schedule-dom"
              label="Day of the month"
              min={1}
              max={28}
              value={schedule.dayOfMonth ?? 1}
              onChange={(_event, state) => setSchedule({ dayOfMonth: Number(state.value) || 1 })}
            />
          )}
          <p className="nc-note">
            {openDay
              ? 'Runs once for every scheduled open day; cancelled days are skipped. The open day becomes the context: its fields can be tested and used in the message.'
              : 'Runs in the makerspace time zone (Europe/Vienna). Use For each to look at people, open days, orders and more each time it runs.'}
          </p>
        </div>
      )}
    </FlowStep>
  );
}

export function LoopStep({ catalog, definition, edit }: StepProps) {
  const loop = definition.loop;
  const ctx = contextOf(catalog, definition);
  const toggle = (
    <Toggle
      id="nc-loop-on"
      size="sm"
      labelText="For each"
      hideLabel
      labelA="Off"
      labelB="On"
      toggled={Boolean(loop)}
      onToggle={(on) =>
        edit(
          (draft) => {
            draft.loop = on ? blankDefinition(catalog, 'loop').loop : null;
          },
          { prune: true },
        )
      }
    />
  );
  if (!loop || !ctx.collection) {
    return (
      <FlowStep icon={Repeat} eyebrow="For each" title="Repeat" right={toggle} off>
        <p className="nc-note">
          Go through every person, open day, machine, spool, order, job, article or training. Run the rest of the rule
          once for each of them, or send one summary of all that match.
        </p>
      </FlowStep>
    );
  }
  const filterGroups = fieldGroups(catalog, definition, 'filter');
  return (
    <FlowStep icon={Repeat} eyebrow="For each" title="Repeat" right={toggle}>
      <div className="nc-loop">
        <Select
          id="nc-loop-collection"
          labelText="Go through"
          value={loop.collection}
          onChange={(event) =>
            edit(
              (draft) => {
                if (draft.loop)
                  draft.loop = { collection: event.target.value, mode: draft.loop.mode, filter: emptySet() };
              },
              { prune: true },
            )
          }
        >
          {catalog.collections.map((collection) => (
            <SelectItem key={collection.key} value={collection.key} text={collection.label} />
          ))}
        </Select>
        <ContentSwitcher
          size="md"
          selectedIndex={loop.mode === 'summary' ? 1 : 0}
          onChange={({ name }) =>
            edit(
              (draft) => {
                if (draft.loop) draft.loop.mode = String(name);
              },
              { prune: true },
            )
          }
        >
          <Switch name="each" text={`One run per ${ctx.collection.one}`} />
          <Switch name="summary" text="One summary" />
        </ContentSwitcher>
      </div>
      {loop.mode === 'each' ? (
        <p className="nc-note">
          Everything below runs once for each {ctx.collection.one}. Conditions can test this {ctx.collection.one}&apos;s
          fields and placeholders hold its own values.
        </p>
      ) : (
        <>
          <ConditionList
            id="nc-filter"
            set={loop.filter}
            groups={filterGroups}
            lead={`Count the ${ctx.collection.plural} where`}
            allowGroups={false}
            onChange={(next) =>
              edit((draft) => {
                if (draft.loop) draft.loop.filter = next;
              })
            }
          />
          {loop.filter.items.length === 0 && <p className="nc-note">No filter: every {ctx.collection.one} counts.</p>}
          <p className="nc-note">
            The rule then runs once with the result: use the summary fields (such as the number of matching{' '}
            {ctx.collection.plural}) in the conditions and the message.
          </p>
        </>
      )}
    </FlowStep>
  );
}

export function ConditionsStep({ catalog, definition, edit }: StepProps) {
  const ctx = contextOf(catalog, definition);
  const groups = fieldGroups(catalog, definition, 'if');
  const lead = ctx.eachMode
    ? `Continue for a ${ctx.collection!.one} only if`
    : ctx.summaryMode
      ? 'Send the summary only if'
      : 'Continue only if';
  const items = definition.conditions.items;
  return (
    <FlowStep icon={Filter} eyebrow="If" title="Conditions" off={!items.length}>
      {items.length === 0 && (
        <p className="nc-note">
          No conditions:{' '}
          {ctx.eachMode ? `every ${ctx.collection!.one} gets through` : 'the rule runs every time the trigger fires'}.
        </p>
      )}
      <ConditionList
        id="nc-if"
        set={definition.conditions}
        groups={groups}
        lead={lead}
        allowGroups
        onChange={(next) =>
          edit((draft) => {
            draft.conditions = next;
          })
        }
      />
      <p className="nc-note">
        Fields: {groups.map((group) => group.label).join(' · ')}. Numbers can be compared with another field.
      </p>
    </FlowStep>
  );
}
