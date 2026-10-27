import { useState } from 'react';
import { Button, InlineNotification, NumberInput, Tile, Toggle } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { updateRunRecordingSettings } from '../../../api/generated/machine-runs/machine-runs';
import type { RunRecordingSettings } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';
import { machineLogbookKeys, recordingSettingsQuery } from '../queries';
import { QueryBoundary } from '../shared/QueryBoundary';
import { useNotify } from '../shared/toasts';
import { useCan } from '../shared/useCan';
import { formatFileSize } from './recordingText';
import './recording.scss';

const MAX_RETENTION_DAYS = 3650;

function SettingsForm({ settings }: { settings: RunRecordingSettings }) {
  const client = useQueryClient();
  const notify = useNotify();
  const canManage = useCan()('machines.manage');
  const [enabled, setEnabled] = useState(settings.timelapseEnabled);
  const [days, setDays] = useState(settings.timelapseRetentionDays);
  const validDays = Number.isInteger(days) && days >= 0 && days <= MAX_RETENTION_DAYS;
  const unchanged = enabled === settings.timelapseEnabled && days === settings.timelapseRetentionDays;
  const save = useMutation({
    mutationFn: () =>
      updateRunRecordingSettings({
        timelapseEnabled: enabled,
        timelapseRetentionDays: days,
        expectedVersion: settings.version,
      }),
    onSuccess: async () => {
      notify({ kind: 'success', title: 'Recording settings saved' });
      await client.invalidateQueries({ queryKey: machineLogbookKeys.recordingSettings() });
    },
  });

  return (
    <Tile className="recording-settings">
      <h3 className="mj-section-title">Timelapses</h3>
      <div className="mj-stack">
        <Toggle
          id="timelapse-enabled"
          labelText="Collect timelapses"
          labelA="Off"
          labelB="On"
          toggled={enabled}
          disabled={!canManage}
          onToggle={setEnabled}
        />
        <NumberInput
          id="timelapse-retention-days"
          label="Keep timelapses for (days)"
          helperText={`0 keeps them until their run is deleted. Videos above ${formatFileSize(settings.timelapseMaxBytes)} are not stored.`}
          min={0}
          max={MAX_RETENTION_DAYS}
          step={1}
          allowEmpty
          value={Number.isNaN(days) ? '' : days}
          disabled={!canManage}
          invalid={!validDays}
          invalidText={`Enter a whole number of days from 0 to ${MAX_RETENTION_DAYS}.`}
          onChange={(_event, state) => setDays(state.value === '' ? Number.NaN : Number(state.value))}
        />
        {save.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Settings not saved"
            subtitle={
              save.error instanceof ApiError && save.error.status === 409
                ? 'Someone else changed the settings. Reload the page and try again.'
                : 'The settings could not be saved. Try again.'
            }
          />
        )}
        {canManage ? (
          <div className="recording-actions">
            <Button disabled={!validDays || unchanged || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
          </div>
        ) : (
          <p className="mj-secondary">Changing these settings needs the permission to manage machines.</p>
        )}
      </div>
    </Tile>
  );
}

/** Installation-wide settings for timelapse collection and retention. */
export function RecordingSettingsTab() {
  const query = useQuery(recordingSettingsQuery());
  return (
    <QueryBoundary query={query} errorMessage="The recording settings could not be loaded.">
      {query.data && <SettingsForm key={query.data.version} settings={query.data} />}
    </QueryBoundary>
  );
}
