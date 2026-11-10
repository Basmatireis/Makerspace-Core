import {
  Checkbox,
  CheckboxGroup,
  InlineNotification,
  Modal,
  MultiSelect,
  NumberInput,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import type {
  SignageMultiMode,
  SignageRule,
  SignageRuleConditionKind,
  SignageRuleRequest,
} from '../../api/generated/models';
import { errorMessage, isStaleWrite } from './helpers';
import { ownerInfo, ownerRefreshKeys, ownerRulesKey, ruleApi, type PlaybackOwner } from './playbackOwner';
import { useMachineOptions } from './preview';
import { SceneListFields } from './SceneListFields';
import { newSceneListItem, sceneListDraftOf, sceneListError, type SceneListDraftItem } from './sceneListDraft';
import { scenesQuery, templatesQuery } from './queries';

const WEEKDAYS = [
  ['Mon', 1],
  ['Tue', 2],
  ['Wed', 3],
  ['Thu', 4],
  ['Fri', 5],
  ['Sat', 6],
  ['Sun', 7],
] as const;
type Option = { id: string; label: string };
type Values = {
  kind: SignageRuleConditionKind;
  weekdays: number[];
  timeFrom: string;
  timeTo: string;
  machineIds: string[];
  machineMatch: 'any' | 'all';
  onlyTemplates: boolean;
  templateIds: string[];
  scenes: SceneListDraftItem[];
  multiMode: SignageMultiMode;
  alternateSeconds: number;
  minSeconds: number;
};

const initialValues = (rule?: SignageRule): Values => ({
  kind: rule?.conditionKind ?? 'time_window',
  weekdays: rule?.conditionKind === 'time_window' ? rule.weekdays : [1, 2, 3, 4, 5],
  timeFrom: rule?.timeFrom ?? '08:00',
  timeTo: rule?.timeTo ?? '10:00',
  machineIds: rule?.machineIds ?? [],
  machineMatch: rule?.machineMatch ?? 'any',
  onlyTemplates: (rule?.announcementTemplateIds.length ?? 0) > 0,
  templateIds: rule?.announcementTemplateIds ?? [],
  scenes: rule ? sceneListDraftOf(rule.scenes) : [newSceneListItem()],
  multiMode: rule?.multiMode ?? 'split',
  alternateSeconds: rule?.alternateSeconds ?? 10,
  minSeconds: rule?.minSeconds ?? 20,
});

/**
 * Adds a rule ("When … show …") to a display or a group, or edits one. Rules are drafts until the owner is published.
 * `version` is the owner version from the rule list that is shown.
 */
export function RuleModal({
  owner,
  version,
  rule,
  onClose,
}: {
  owner: PlaybackOwner;
  version: number;
  rule?: SignageRule;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { id: ownerId, kind: ownerKind, name: ownerName, aspectRatio } = ownerInfo(owner);
  const { machines } = useMachineOptions();
  const scenes = useQuery(scenesQuery()).data?.items;
  const templates = useQuery(templatesQuery()).data?.items;
  const form = useForm<Values>({ defaultValues: initialValues(rule) });
  const { errors } = form.formState;
  const [kind, machineIds, chosenScenes, multiMode, onlyTemplates] = form.watch([
    'kind',
    'machineIds',
    'scenes',
    'multiMode',
    'onlyTemplates',
  ]);

  const hasCamera = chosenScenes.some((item) =>
    Object.values(scenes?.find((scene) => scene.id === item.sceneId)?.zones ?? {}).some(
      (widget) => widget.type === 'camera',
    ),
  );
  const askMulti = kind === 'machine_printing' && machineIds.length > 1 && hasCamera;
  const machineItems: Option[] = machines.map((machine) => ({ id: machine.id, label: machine.name }));
  const templateItems: Option[] = (templates ?? []).map((template) => ({ id: template.id, label: template.name }));

  // The owner, the lists and the preview follow the owner's drafts (a group's members' pending changes too).
  const ownerKeys = ownerRefreshKeys({ kind: ownerKind, id: ownerId });

  const mutation = useMutation({
    mutationFn: (values: Values) => {
      const request: SignageRuleRequest = {
        expectedVersion: version,
        enabled: rule?.enabled ?? true,
        conditionKind: values.kind,
        scenes: values.scenes.map(({ sceneId, seconds, transition }) => ({
          sceneId,
          seconds: seconds >= 3 && seconds <= 3600 ? seconds : 20,
          transition,
        })),
        minSeconds: values.minSeconds,
        multiMode: askMulti ? values.multiMode : (rule?.multiMode ?? 'split'),
        alternateSeconds:
          askMulti && values.multiMode === 'alternate' ? values.alternateSeconds : (rule?.alternateSeconds ?? 10),
        ...(values.kind === 'time_window'
          ? { weekdays: values.weekdays, timeFrom: values.timeFrom, timeTo: values.timeTo }
          : {}),
        ...(values.kind === 'machine_printing'
          ? { machineIds: values.machineIds, machineMatch: values.machineMatch }
          : {}),
        ...(values.kind === 'announcement_active'
          ? { announcementTemplateIds: values.onlyTemplates ? values.templateIds : [] }
          : {}),
      };
      const api = ruleApi({ kind: ownerKind, id: ownerId });
      return rule ? api.update(rule.id, request) : api.create(request);
    },
    onSuccess: async (list) => {
      queryClient.setQueryData(ownerRulesKey({ kind: ownerKind, id: ownerId }), list);
      await Promise.all(ownerKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
      onClose();
    },
    onError: (error) => {
      if (isStaleWrite(error))
        void Promise.all(
          [ownerRulesKey({ kind: ownerKind, id: ownerId }), ownerKeys[0]].map((queryKey) =>
            queryClient.invalidateQueries({ queryKey }),
          ),
        );
    },
  });

  return (
    <Modal
      open
      size="md"
      modalHeading={rule ? 'Edit rule' : 'Add rule'}
      modalLabel={ownerName}
      primaryButtonText={mutation.isPending ? 'Saving…' : rule ? 'Save rule' : 'Add rule'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={() => void form.handleSubmit((values) => mutation.mutate(values))()}
    >
      <Stack gap={5}>
        <Select id="rule-kind" labelText="When" {...form.register('kind')}>
          <SelectItem value="time_window" text="Time window" />
          <SelectItem value="machine_printing" text="Machine printing" />
          <SelectItem value="announcement_active" text="Announcement active" />
          <SelectItem value="live_data_unavailable" text="Live data unavailable" />
        </Select>
        {kind === 'time_window' && (
          <>
            <Controller
              control={form.control}
              name="weekdays"
              rules={{
                validate: (value) =>
                  form.getValues('kind') !== 'time_window' || value.length > 0 || 'Choose at least one weekday',
              }}
              render={({ field }) => (
                <CheckboxGroup
                  legendText="Weekdays"
                  orientation="horizontal"
                  invalid={Boolean(errors.weekdays)}
                  invalidText={errors.weekdays?.message}
                >
                  {WEEKDAYS.map(([label, value]) => (
                    <Checkbox
                      key={value}
                      id={`rule-day-${value}`}
                      labelText={label}
                      checked={field.value.includes(value)}
                      onChange={(_, { checked }) =>
                        field.onChange(
                          checked ? [...field.value, value].sort() : field.value.filter((item) => item !== value),
                        )
                      }
                    />
                  ))}
                </CheckboxGroup>
              )}
            />
            <div className="sg-form-row">
              <TextInput
                id="rule-from"
                type="time"
                labelText="From"
                invalid={Boolean(errors.timeFrom)}
                invalidText={errors.timeFrom?.message}
                {...form.register('timeFrom', {
                  validate: (value) =>
                    form.getValues('kind') !== 'time_window' ||
                    (value !== '' && value !== form.getValues('timeTo')) ||
                    'Start and end must differ',
                })}
              />
              <TextInput
                id="rule-to"
                type="time"
                labelText="To"
                helperText="A later start than end runs over midnight."
                invalid={Boolean(errors.timeTo)}
                invalidText="Choose an end time"
                {...form.register('timeTo', {
                  validate: (value) => form.getValues('kind') !== 'time_window' || value !== '',
                })}
              />
            </div>
          </>
        )}
        {kind === 'machine_printing' && (
          <>
            <Controller
              control={form.control}
              name="machineIds"
              rules={{
                validate: (value) =>
                  form.getValues('kind') !== 'machine_printing' || value.length > 0 || 'Choose at least one machine',
              }}
              render={({ field }) => (
                <MultiSelect<Option>
                  autoAlign
                  key={machineItems.length}
                  id="rule-machines"
                  titleText="Machines"
                  label="Choose machines"
                  items={machineItems}
                  itemToString={(item) => item?.label ?? ''}
                  initialSelectedItems={machineItems.filter((item) => field.value.includes(item.id))}
                  invalid={Boolean(errors.machineIds)}
                  invalidText={errors.machineIds?.message}
                  onChange={({ selectedItems }) => field.onChange((selectedItems ?? []).map((item) => item.id))}
                />
              )}
            />
            <Controller
              control={form.control}
              name="machineMatch"
              render={({ field }) => (
                <RadioButtonGroup
                  legendText="Matches when"
                  name="rule-mode"
                  valueSelected={field.value}
                  onChange={(value) => field.onChange(value)}
                >
                  <RadioButton id="rule-mode-any" value="any" labelText="Any of them is printing" />
                  <RadioButton id="rule-mode-all" value="all" labelText="All of them are printing" />
                </RadioButtonGroup>
              )}
            />
          </>
        )}
        {kind === 'announcement_active' && (
          <>
            <Controller
              control={form.control}
              name="onlyTemplates"
              render={({ field }) => (
                <RadioButtonGroup
                  legendText="Matches"
                  name="rule-announcement"
                  valueSelected={field.value ? 'only' : 'any'}
                  onChange={(value) => field.onChange(value === 'only')}
                >
                  <RadioButton id="rule-announcement-any" value="any" labelText="Any announcement" />
                  <RadioButton
                    id="rule-announcement-only"
                    value="only"
                    labelText="Only announcements from certain templates"
                  />
                </RadioButtonGroup>
              )}
            />
            {onlyTemplates && (
              <Controller
                control={form.control}
                name="templateIds"
                rules={{
                  validate: (value) =>
                    form.getValues('kind') !== 'announcement_active' ||
                    !form.getValues('onlyTemplates') ||
                    value.length > 0 ||
                    'Choose at least one template',
                }}
                render={({ field }) => (
                  <MultiSelect<Option>
                    autoAlign
                    key={templateItems.length}
                    id="rule-templates"
                    titleText="Templates"
                    label="Choose templates"
                    items={templateItems}
                    itemToString={(item) => item?.label ?? ''}
                    initialSelectedItems={templateItems.filter((item) => field.value.includes(item.id))}
                    invalid={Boolean(errors.templateIds)}
                    invalidText={errors.templateIds?.message}
                    onChange={({ selectedItems }) => field.onChange((selectedItems ?? []).map((item) => item.id))}
                  />
                )}
              />
            )}
            <p className="sg-secondary">
              Matches while a matching announcement is active on the display. The position in the list is the only
              priority.
            </p>
          </>
        )}
        {kind === 'live_data_unavailable' && (
          <p className="sg-secondary">
            Matches while the display has not been able to load live data for over a minute.
          </p>
        )}
        <Controller
          control={form.control}
          name="scenes"
          rules={{ validate: (value) => sceneListError(value) ?? true }}
          render={({ field }) => (
            <SceneListFields
              idPrefix="rule"
              label="Show"
              value={field.value}
              onChange={field.onChange}
              aspectRatio={aspectRatio}
              invalidText={errors.scenes?.message}
            />
          )}
        />
        {askMulti && (
          <>
            <Controller
              control={form.control}
              name="multiMode"
              render={({ field }) => (
                <RadioButtonGroup
                  legendText="When several machines print"
                  name="rule-multi"
                  valueSelected={field.value}
                  onChange={(value) => field.onChange(value)}
                >
                  <RadioButton id="rule-multi-split" value="split" labelText="Split screen" />
                  <RadioButton id="rule-multi-alt" value="alternate" labelText="Alternate" />
                </RadioButtonGroup>
              )}
            />
            {multiMode === 'alternate' && (
              <Controller
                control={form.control}
                name="alternateSeconds"
                rules={{ validate: (value) => (value >= 3 && value <= 600) || 'Enter 3 to 600 seconds' }}
                render={({ field }) => (
                  <NumberInput
                    id="rule-alt"
                    label="Alternate every (seconds)"
                    min={3}
                    max={600}
                    value={field.value}
                    invalid={Boolean(errors.alternateSeconds)}
                    invalidText={errors.alternateSeconds?.message}
                    onChange={(_, { value }) => field.onChange(value === '' ? Number.NaN : Number(value))}
                  />
                )}
              />
            )}
          </>
        )}
        <Controller
          control={form.control}
          name="minSeconds"
          rules={{
            validate: (value) => (Number.isInteger(value) && value >= 0 && value <= 600) || 'Enter 0 to 600 seconds',
          }}
          render={({ field }) => (
            <NumberInput
              id="rule-min"
              label="Minimum display time (seconds)"
              helperText="Prevents flicker when a printer reconnects."
              min={0}
              max={600}
              value={field.value}
              invalid={Boolean(errors.minSeconds)}
              invalidText={errors.minSeconds?.message}
              onChange={(_, { value }) => field.onChange(value === '' ? Number.NaN : Number(value))}
            />
          )}
        />
        {mutation.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Rule not saved"
            subtitle={
              isStaleWrite(mutation.error)
                ? `The rules of this ${ownerKind} were changed somewhere else. The list was refreshed; save again to apply your rule on top.`
                : errorMessage(mutation.error)
            }
          />
        )}
      </Stack>
    </Modal>
  );
}
