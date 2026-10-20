import {
  Button,
  InlineNotification,
  RadioButton,
  RadioButtonGroup,
  Select,
  SelectItem,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  TextInput,
  Toggle,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import type { SignageDisplay, SignageOrientation, UpdateSignageDisplayRequest } from '../../api/generated/models';
import { useUpdateDisplay } from './displayMutations';
import { errorMessage, isStaleWrite, orientationLabel, resolutionLabel, resolutionOptions } from './helpers';
import { playlistsQuery } from './queries';

type Values = {
  name: string;
  location: string;
  orientation: SignageOrientation;
  resolution: string;
  visibleFromOutside: boolean;
  allowCameraOutside: boolean;
  defaultPlaylistId: string;
};

const valuesOf = (display: SignageDisplay): Values => ({
  name: display.name,
  location: display.location,
  orientation: display.orientation,
  resolution: String(
    resolutionOptions(display.orientation, display.resolution).findIndex(
      (item) => item.width === display.resolution.width && item.height === display.resolution.height,
    ),
  ),
  visibleFromOutside: display.visibleFromOutside,
  allowCameraOutside: display.allowCameraOutside,
  defaultPlaylistId: display.defaultPlaylistId,
});

export function DisplaySettingsTab({ display, canManage }: { display: SignageDisplay; canManage: boolean }) {
  const playlists = useQuery(playlistsQuery());
  const update = useUpdateDisplay(display.id);
  const form = useForm<Values>({ defaultValues: valuesOf(display) });
  const orientation = form.watch('orientation');
  const { errors, isDirty } = form.formState;

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
            <StructuredListCell noWrap>Format</StructuredListCell>
            <StructuredListCell>
              {orientationLabel(display.orientation)} {resolutionLabel(display.resolution)}
            </StructuredListCell>
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
    const resolution = resolutionOptions(
      values.orientation,
      values.orientation === display.orientation ? display.resolution : undefined,
    )[Number(values.resolution)];
    const request: UpdateSignageDisplayRequest = {
      expectedVersion: display.version,
      name: values.name.trim(),
      location: values.location.trim(),
      orientation: values.orientation,
      resolution,
      visibleFromOutside: values.visibleFromOutside,
      allowCameraOutside: values.visibleFromOutside && values.allowCameraOutside,
      defaultPlaylistId: values.defaultPlaylistId,
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
      <Controller
        control={form.control}
        name="orientation"
        render={({ field }) => (
          <RadioButtonGroup
            legendText="Orientation"
            name="ds-orientation"
            valueSelected={field.value}
            onChange={(value) => {
              field.onChange(value);
              form.setValue('resolution', '0', { shouldDirty: true });
            }}
          >
            <RadioButton id="ds-portrait" value="portrait" labelText="Portrait" />
            <RadioButton id="ds-landscape" value="landscape" labelText="Landscape" />
          </RadioButtonGroup>
        )}
      />
      <Select id="ds-resolution" labelText="Resolution" {...form.register('resolution')}>
        {resolutionOptions(orientation, orientation === display.orientation ? display.resolution : undefined).map(
          (item, index) => (
            <SelectItem key={resolutionLabel(item)} value={String(index)} text={resolutionLabel(item)} />
          ),
        )}
      </Select>
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
      <Select
        id="ds-playlist"
        labelText="Default playlist"
        helperText="Changing it needs publishing."
        {...form.register('defaultPlaylistId')}
      >
        {(playlists.data?.items ?? []).map((playlist) => (
          <SelectItem key={playlist.id} value={playlist.id} text={playlist.name} />
        ))}
      </Select>
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
