import { useState } from 'react';
import {
  Button,
  Checkbox,
  CheckboxGroup,
  InlineNotification,
  NumberInput,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Tile,
  Toggle,
} from '@carbon/react';
import { Controller, useForm } from 'react-hook-form';
import type { SignageWebEmbed } from '../../api/generated/models';
import { useUpdateEmbed } from './embedMutations';
import { errorMessage, isStaleWrite } from './helpers';
import { useMachineOptions } from './preview';
import { MediaConfirmModal, type MediaKind } from './WebEmbedDialogs';

const SHOWN: [string, string, boolean][] = [
  ['Open days', 'Next 5 public: date, time, public area labels', true],
  ['Public events', 'Title, time, location', true],
  ['Announcements', 'Only those picked for this embed', true],
  ['Printer status', 'Name, printing or ready, progress, time left', true],
  ['File and job names', 'Never shown', false],
  ['Who is printing', 'Never shown', false],
];

const numberChange =
  (field: { onChange: (value: number) => void }) =>
  (_: unknown, { value }: { value: string | number }) =>
    field.onChange(value === '' ? Number.NaN : Number(value));

function CameraDetails({ embed }: { embed: SignageWebEmbed }) {
  const update = useUpdateEmbed(embed.id);
  const { machines } = useMachineOptions();
  const printers = machines.filter((machine) => machine.hasCamera || embed.cameraMachineIds.includes(machine.id));
  const form = useForm<{ machineIds: string[]; viewers: number }>({
    defaultValues: { machineIds: embed.cameraMachineIds, viewers: embed.cameraViewerLimit },
  });
  const { errors, isDirty } = form.formState;
  const save = form.handleSubmit((values) =>
    update.mutate(
      { expectedVersion: embed.version, cameraMachineIds: values.machineIds, cameraViewerLimit: values.viewers },
      { onSuccess: (saved) => form.reset({ machineIds: saved.cameraMachineIds, viewers: saved.cameraViewerLimit }) },
    ),
  );
  return (
    <Stack gap={5}>
      <Controller
        control={form.control}
        name="machineIds"
        render={({ field }) => (
          <CheckboxGroup legendText="Printers whose camera is shown">
            {printers.length === 0 && <p className="sg-secondary">No printer with a camera is set up.</p>}
            {printers.map((machine) => (
              <Checkbox
                key={machine.id}
                id={`embed-camera-${machine.id}`}
                labelText={machine.name}
                checked={field.value.includes(machine.id)}
                onChange={(_, { checked }) =>
                  field.onChange(checked ? [...field.value, machine.id] : field.value.filter((id) => id !== machine.id))
                }
              />
            ))}
          </CheckboxGroup>
        )}
      />
      <Controller
        control={form.control}
        name="viewers"
        rules={{ validate: (value) => (value >= 1 && value <= 20) || 'Enter 1 to 20 viewers' }}
        render={({ field }) => (
          <NumberInput
            id="embed-camera-viewers"
            label="Viewers at the same time"
            helperText="More viewers see the camera's fallback (“Camera busy”). Protects the printers' upload."
            min={1}
            max={20}
            value={field.value}
            invalid={Boolean(errors.viewers)}
            invalidText={errors.viewers?.message}
            onChange={numberChange(field)}
          />
        )}
      />
      {update.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Cameras not saved"
          subtitle={
            isStaleWrite(update.error)
              ? 'This web embed was changed somewhere else. Try again.'
              : errorMessage(update.error)
          }
        />
      )}
      <div>
        <Button kind="tertiary" size="md" disabled={!isDirty || update.isPending} onClick={() => void save()}>
          {update.isPending ? 'Saving…' : 'Save cameras'}
        </Button>
      </div>
    </Stack>
  );
}

function TimelapseDetails({ embed }: { embed: SignageWebEmbed }) {
  const update = useUpdateEmbed(embed.id);
  const form = useForm<{ count: number; days: number }>({
    defaultValues: { count: embed.timelapseCount, days: embed.timelapseMaxAgeDays },
  });
  const { errors, isDirty } = form.formState;
  const save = form.handleSubmit((values) =>
    update.mutate(
      { expectedVersion: embed.version, timelapseCount: values.count, timelapseMaxAgeDays: values.days },
      { onSuccess: (saved) => form.reset({ count: saved.timelapseCount, days: saved.timelapseMaxAgeDays }) },
    ),
  );
  return (
    <Stack gap={5}>
      <Controller
        control={form.control}
        name="count"
        rules={{ validate: (value) => (value >= 1 && value <= 20) || 'Enter 1 to 20 runs' }}
        render={({ field }) => (
          <NumberInput
            id="embed-timelapse-count"
            label="Last runs"
            min={1}
            max={20}
            value={field.value}
            invalid={Boolean(errors.count)}
            invalidText={errors.count?.message}
            onChange={numberChange(field)}
          />
        )}
      />
      <Controller
        control={form.control}
        name="days"
        rules={{ validate: (value) => (value >= 1 && value <= 90) || 'Enter 1 to 90 days' }}
        render={({ field }) => (
          <NumberInput
            id="embed-timelapse-days"
            label="Not older than (days)"
            min={1}
            max={90}
            value={field.value}
            invalid={Boolean(errors.days)}
            invalidText={errors.days?.message}
            onChange={numberChange(field)}
          />
        )}
      />
      {update.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Timelapses not saved"
          subtitle={
            isStaleWrite(update.error)
              ? 'This web embed was changed somewhere else. Try again.'
              : errorMessage(update.error)
          }
        />
      )}
      <div>
        <Button kind="tertiary" size="md" disabled={!isDirty || update.isPending} onClick={() => void save()}>
          {update.isPending ? 'Saving…' : 'Save timelapses'}
        </Button>
      </div>
    </Stack>
  );
}

/** What the embed shows besides public information. Switching cameras or timelapses on asks first; off applies at once. */
export function WebEmbedDataTab({ embed, canManage }: { embed: SignageWebEmbed; canManage: boolean }) {
  const update = useUpdateEmbed(embed.id);
  const { machines } = useMachineOptions();
  const [confirming, setConfirming] = useState<MediaKind | null>(null);

  const turnOn = () => {
    if (confirming === null) return;
    const request =
      confirming === 'camera'
        ? {
            cameraEnabled: true,
            // A first printer to start with; more are ticked afterwards.
            cameraMachineIds:
              embed.cameraMachineIds.length > 0
                ? embed.cameraMachineIds
                : machines
                    .filter((machine) => machine.hasCamera)
                    .slice(0, 1)
                    .map((machine) => machine.id),
          }
        : { timelapseEnabled: true };
    update.mutate({ expectedVersion: embed.version, ...request }, { onSuccess: () => setConfirming(null) });
  };
  const toggle = (kind: MediaKind, checked: boolean) => {
    if (checked) setConfirming(kind);
    else
      update.mutate({
        expectedVersion: embed.version,
        ...(kind === 'camera' ? { cameraEnabled: false } : { timelapseEnabled: false }),
      });
  };

  return (
    <Stack gap={6} className="sg-tab">
      <Tile>
        <Stack gap={4}>
          <h2 className="sg-section-title">Always shown: public information</h2>
          <p className="sg-secondary">
            The same data a display marked “visible from outside” shows. Nothing about people, no sign-ups, no names of
            who printed what.
          </p>
          <StructuredListWrapper isCondensed aria-label="Public information">
            <StructuredListBody>
              {SHOWN.map(([name, detail, shown]) => (
                <StructuredListRow key={name}>
                  <StructuredListCell noWrap>{name}</StructuredListCell>
                  <StructuredListCell>{detail}</StructuredListCell>
                  <StructuredListCell className="sg-secondary">{shown ? 'Shown' : ''}</StructuredListCell>
                </StructuredListRow>
              ))}
            </StructuredListBody>
          </StructuredListWrapper>
        </Stack>
      </Tile>
      <Tile>
        <Stack gap={5}>
          <h2 className="sg-section-title">Extra content</h2>
          <InlineNotification
            kind="warning"
            lowContrast
            hideCloseButton
            title="Cameras and timelapses show the workshop."
            subtitle="People in the room may be visible to anyone who reads the website. Allow them only for cameras that point at the print bed, and keep the sign at the door up to date."
          />
          <Toggle
            id="embed-camera"
            labelText="Printer cameras"
            labelA="Off"
            labelB="On"
            toggled={embed.cameraEnabled}
            disabled={!canManage || update.isPending}
            onToggle={(checked) => toggle('camera', checked)}
          />
          <p className="sg-secondary">
            Live picture of the chosen printers while they print. Same relay as displays; no picture when a run is
            hidden from signage.
          </p>
          {embed.cameraEnabled && (canManage ? <CameraDetails key={embed.version} embed={embed} /> : null)}
          <Toggle
            id="embed-timelapse"
            labelText="Timelapses"
            labelA="Off"
            labelB="On"
            toggled={embed.timelapseEnabled}
            disabled={!canManage || update.isPending}
            onToggle={(checked) => toggle('timelapse', checked)}
          />
          <p className="sg-secondary">
            Finished runs with a timelapse. The caption is printer and date only. Runs hidden from signage never appear.
          </p>
          {embed.timelapseEnabled && (canManage ? <TimelapseDetails key={embed.version} embed={embed} /> : null)}
          {update.isError && confirming === null && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Not saved"
              subtitle={
                isStaleWrite(update.error)
                  ? 'This web embed was changed somewhere else. Try again.'
                  : errorMessage(update.error)
              }
            />
          )}
        </Stack>
      </Tile>
      {confirming !== null && (
        <MediaConfirmModal
          kind={confirming}
          embed={embed}
          pending={update.isPending}
          error={update.isError ? errorMessage(update.error) : undefined}
          onConfirm={turnOn}
          onClose={() => {
            update.reset();
            setConfirming(null);
          }}
        />
      )}
    </Stack>
  );
}
