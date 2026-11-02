import {
  Button,
  InlineNotification,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  TextInput,
  Toggle,
} from '@carbon/react';
import { Controller, useForm } from 'react-hook-form';
import type { SignageDisplay, UpdateSignageDisplayRequest } from '../../api/generated/models';
import { DisplayGroupSelect } from './DisplayGroupSelect';
import { useUpdateDisplay } from './displayMutations';
import { aspectFieldsOf, aspectOfFields, type AspectFields } from './aspectFields';
import { AspectRatioFields } from './AspectRatioFields';
import { aspectLabel, errorMessage, isStaleWrite, sameRatio } from './helpers';

type Values = AspectFields & {
  name: string;
  location: string;
  visibleFromOutside: boolean;
  allowCameraOutside: boolean;
  groupId: string;
};

const valuesOf = (display: SignageDisplay): Values => ({
  name: display.name,
  location: display.location,
  ...aspectFieldsOf(display.aspectRatio),
  visibleFromOutside: display.visibleFromOutside,
  allowCameraOutside: display.allowCameraOutside,
  groupId: display.groupId ?? '',
});

export function DisplaySettingsTab({ display, canManage }: { display: SignageDisplay; canManage: boolean }) {
  const update = useUpdateDisplay(display.id);
  const form = useForm<Values>({ defaultValues: valuesOf(display) });
  const { errors, isDirty } = form.formState;
  const [aspectPreset, aspectCustom] = form.watch(['aspectPreset', 'aspectCustom']);
  const ratio = aspectOfFields({ aspectPreset, aspectCustom });
  const ratioChanged = !sameRatio(ratio, display.aspectRatio);
  const groupId = form.watch('groupId');
  const joining = groupId !== '' && groupId !== display.groupId;
  const leaving = groupId === '' && display.groupId !== null;
  const inGroup = display.groupId !== null;

  if (!canManage || display.status === 'revoked') {
    return (
      <StructuredListWrapper isCondensed aria-label="Display settings">
        <StructuredListBody>
          <StructuredListRow>
            <StructuredListCell noWrap>Name</StructuredListCell>
            <StructuredListCell>{display.name}</StructuredListCell>
          </StructuredListRow>
          <StructuredListRow>
            <StructuredListCell noWrap>Location</StructuredListCell>
            <StructuredListCell>{display.location || '—'}</StructuredListCell>
          </StructuredListRow>
          <StructuredListRow>
            <StructuredListCell noWrap>Aspect ratio</StructuredListCell>
            <StructuredListCell>{aspectLabel(display.aspectRatio)}</StructuredListCell>
          </StructuredListRow>
          <StructuredListRow>
            <StructuredListCell noWrap>Visible from outside</StructuredListCell>
            <StructuredListCell>{display.visibleFromOutside ? 'Yes' : 'No'}</StructuredListCell>
          </StructuredListRow>
          {display.visibleFromOutside && (
            <StructuredListRow>
              <StructuredListCell noWrap>Live cameras</StructuredListCell>
              <StructuredListCell>{display.allowCameraOutside ? 'Shown' : 'Not shown'}</StructuredListCell>
            </StructuredListRow>
          )}
        </StructuredListBody>
      </StructuredListWrapper>
    );
  }

  const save = form.handleSubmit((values) => {
    const request: UpdateSignageDisplayRequest = {
      expectedVersion: display.version,
      name: values.name.trim(),
      location: values.location.trim(),
      aspectRatio: aspectOfFields(values),
      visibleFromOutside: values.visibleFromOutside,
      allowCameraOutside: values.visibleFromOutside && values.allowCameraOutside,
      groupId: values.groupId || null,
      // A member's own list is empty; leaving with an empty list copies the group's.
      defaultScenes: values.groupId || display.groupId ? [] : display.defaultScenes,
    };
    update.mutate(request, { onSuccess: (saved) => form.reset(valuesOf(saved)) });
  });

  return (
    <Stack gap={5} className="sg-tab sg-settings">
      <TextInput
        id="ds-name"
        labelText="Name"
        maxLength={100}
        invalid={Boolean(errors.name)}
        invalidText="Give the display a name"
        {...form.register('name', { validate: (value) => value.trim() !== '' })}
      />
      <TextInput id="ds-location" labelText="Location" maxLength={150} {...form.register('location')} />
      <AspectRatioFields
        form={form}
        idPrefix="ds"
        disabled={inGroup}
        helperText={
          inGroup ? 'The aspect ratio of a display in a group cannot be changed. Leave the group first.' : undefined
        }
      />
      <DisplayGroupSelect
        id="ds-group"
        ratio={ratio}
        value={groupId}
        disabled={ratioChanged}
        onChange={(value) => form.setValue('groupId', value, { shouldDirty: true })}
        helperText={
          ratioChanged
            ? 'Save the new aspect ratio before joining a group.'
            : 'A display in a group plays the group’s rules and default scenes.'
        }
      />
      {joining && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Joining a group replaces the playback"
          subtitle="The display's own rules and default scenes are deleted and replaced by the group's."
        />
      )}
      {leaving && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Leaving the group"
          subtitle="The display keeps a copy of the group's rules and default scenes, which it can then change on its own."
        />
      )}
      <Controller
        control={form.control}
        name="visibleFromOutside"
        render={({ field }) => (
          <Toggle
            id="ds-outside"
            labelText="Visible from outside"
            labelA="No"
            labelB="Yes"
            toggled={field.value}
            onToggle={field.onChange}
          />
        )}
      />
      {form.watch('visibleFromOutside') && (
        <Controller
          control={form.control}
          name="allowCameraOutside"
          render={({ field }) => (
            <Toggle
              id="ds-camera-outside"
              labelText="Show live cameras on this outside-visible display"
              labelA="No"
              labelB="Yes"
              toggled={field.value}
              onToggle={field.onChange}
            />
          )}
        />
      )}
      {form.watch('visibleFromOutside') && (
        <p className="sg-secondary">
          Only enable if the camera never shows people, documents or other private content.
        </p>
      )}
      {ratioChanged && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="The aspect ratio changes"
          subtitle="The default scenes and the scenes of every rule must already have the new aspect ratio; otherwise saving is refused. Edit them under Playback first."
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
              ? 'This display was changed somewhere else and has been refreshed. Check the values and save again.'
              : errorMessage(update.error)
          }
        />
      )}
      {update.isSuccess && !isDirty && (
        <InlineNotification
          kind="success"
          lowContrast
          hideCloseButton
          title="Settings saved"
          subtitle="They reach the display with the next publication."
        />
      )}
      <div>
        <Button
          kind="primary"
          disabled={update.isPending || !isDirty}
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
