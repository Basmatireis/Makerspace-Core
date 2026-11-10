import { Button, InlineNotification, RadioButton, RadioButtonGroup, Stack, TextInput } from '@carbon/react';
import { Controller, useForm } from 'react-hook-form';
import type { SignageWebEmbed, UpdateSignageWebEmbedRequest } from '../../api/generated/models';
import { aspectFieldsOf, aspectOfFields, type AspectFields } from './aspectFields';
import { AspectRatioFields } from './AspectRatioFields';
import { DisplayGroupSelect } from './DisplayGroupSelect';
import { useUpdateEmbed } from './embedMutations';
import { errorMessage, isStaleWrite, sameRatio } from './helpers';

type Values = AspectFields & { name: string; source: 'own' | 'group'; groupId: string };

const valuesOf = (embed: SignageWebEmbed): Values => ({
  name: embed.name,
  ...aspectFieldsOf(embed.aspectRatio),
  source: embed.groupId === null ? 'own' : 'group',
  groupId: embed.groupId ?? '',
});

/** Name, aspect ratio and where the playback comes from: the embed's own rules and scene list, or a display group. */
export function WebEmbedContentSettings({ embed }: { embed: SignageWebEmbed }) {
  const update = useUpdateEmbed(embed.id);
  const form = useForm<Values>({ defaultValues: valuesOf(embed) });
  const { errors, isDirty } = form.formState;
  const [aspectPreset, aspectCustom, source, groupId] = form.watch([
    'aspectPreset',
    'aspectCustom',
    'source',
    'groupId',
  ]);
  const ratio = aspectOfFields({ aspectPreset, aspectCustom });
  const ratioChanged = !sameRatio(ratio, embed.aspectRatio);
  const inGroup = embed.groupId !== null;
  const targetGroup = source === 'group' ? groupId : '';
  const joining = targetGroup !== '' && targetGroup !== embed.groupId;
  const leaving = targetGroup === '' && inGroup;
  const missingGroup = source === 'group' && groupId === '';

  const save = form.handleSubmit((values) => {
    const target = values.source === 'group' ? values.groupId : '';
    const request: UpdateSignageWebEmbedRequest = {
      expectedVersion: embed.version,
      name: values.name.trim(),
      aspectRatio: aspectOfFields(values),
      groupId: target || null,
      // A member's own list is empty; leaving with an empty list copies the group's.
      ...(target !== (embed.groupId ?? '') ? { defaultScenes: [] } : {}),
    };
    update.mutate(request, { onSuccess: (saved) => form.reset(valuesOf(saved)) });
  });

  return (
    <Stack gap={5} className="sg-tab sg-settings">
      <TextInput
        id="embed-settings-name"
        labelText="Name"
        maxLength={100}
        helperText="Only staff see the name."
        invalid={Boolean(errors.name)}
        invalidText="Give the web embed a name"
        {...form.register('name', { validate: (value) => value.trim() !== '' })}
      />
      <AspectRatioFields
        form={form}
        idPrefix="embed-settings"
        disabled={inGroup}
        helperText={
          inGroup
            ? 'The aspect ratio of an embed that follows a group cannot be changed. Stop following the group first.'
            : 'The embed keeps this ratio at any width. Scenes must match it, as on displays.'
        }
      />
      <Controller
        control={form.control}
        name="source"
        render={({ field }) => (
          <RadioButtonGroup
            legendText="Content"
            name="embed-source"
            orientation="vertical"
            valueSelected={field.value}
            onChange={(value) => field.onChange(value)}
          >
            <RadioButton id="embed-source-own" value="own" labelText="Its own rules and scene list" />
            <RadioButton
              id="embed-source-group"
              value="group"
              labelText="The same as a display group (follows its rules and scenes; publishing the group publishes this embed too)"
            />
          </RadioButtonGroup>
        )}
      />
      {source === 'group' && (
        <DisplayGroupSelect
          id="embed-settings-group"
          ratio={ratio}
          value={groupId}
          disabled={ratioChanged}
          onChange={(value) => form.setValue('groupId', value, { shouldDirty: true })}
          helperText={
            ratioChanged
              ? 'Save the new aspect ratio before choosing a group.'
              : 'Only groups with the same aspect ratio are offered.'
          }
        />
      )}
      {joining && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Following a group replaces the playback"
          subtitle="The embed's own rules and default scenes are deleted and replaced by the group's."
        />
      )}
      {leaving && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Stop following the group"
          subtitle="The embed keeps a copy of the group's rules and default scenes, which it can then change on its own."
        />
      )}
      {ratioChanged && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="The aspect ratio changes"
          subtitle="The default scenes and the scenes of every rule must already have the new aspect ratio; otherwise saving is refused."
        />
      )}
      {update.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Settings not saved"
          subtitle={
            isStaleWrite(update.error)
              ? 'This web embed was changed somewhere else and has been refreshed. Check the values and save again.'
              : errorMessage(update.error)
          }
        />
      )}
      <div>
        <Button
          kind="primary"
          disabled={update.isPending || !isDirty || missingGroup}
          onClick={() => {
            void save();
          }}
        >
          {update.isPending ? 'Saving…' : 'Save settings'}
        </Button>
      </div>
    </Stack>
  );
}
