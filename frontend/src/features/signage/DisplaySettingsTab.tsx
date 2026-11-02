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
import { useUpdateDisplay } from './displayMutations';
import { aspectFieldsOf, aspectOfFields, type AspectFields } from './aspectFields';
import { AspectRatioFields } from './AspectRatioFields';
import { aspectLabel, errorMessage, isStaleWrite, sameRatio } from './helpers';

type Values = AspectFields & {
  name: string;
  location: string;
  visibleFromOutside: boolean;
  allowCameraOutside: boolean;
};

const valuesOf = (display: SignageDisplay): Values => ({
  name: display.name,
  location: display.location,
  ...aspectFieldsOf(display.aspectRatio),
  visibleFromOutside: display.visibleFromOutside,
  allowCameraOutside: display.allowCameraOutside,
});

export function DisplaySettingsTab({ display, canManage }: { display: SignageDisplay; canManage: boolean }) {
  const update = useUpdateDisplay(display.id);
  const form = useForm<Values>({ defaultValues: valuesOf(display) });
  const { errors, isDirty } = form.formState;
  const [aspectPreset, aspectCustom] = form.watch(['aspectPreset', 'aspectCustom']);
  const ratioChanged = !sameRatio(aspectOfFields({ aspectPreset, aspectCustom }), display.aspectRatio);

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
      defaultScenes: display.defaultScenes,
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
      <AspectRatioFields form={form} idPrefix="ds" />
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
