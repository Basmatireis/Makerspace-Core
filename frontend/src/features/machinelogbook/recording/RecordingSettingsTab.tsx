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
const MAX_COUNT = 100000;
const MB = 1024 * 1024;
const GB = 1024 * MB;
const MIN_VIDEO_BYTES = MB;
// The API accepts at most 8 GiB per video, and the deployment may allow less.
const MAX_VIDEO_BYTES = 8 * GB;

const bytesOf = (value: number, unit: number) => Math.round(value * unit);

function SettingsForm({ settings }: { settings: RunRecordingSettings }) {
  const client = useQueryClient();
  const notify = useNotify();
  const canManage = useCan()('machines.manage');
  const [enabled, setEnabled] = useState(settings.timelapseEnabled);
  const [days, setDays] = useState(settings.timelapseRetentionDays);
  const [videoMb, setVideoMb] = useState(settings.timelapseMaxBytes / MB);
  const [count, setCount] = useState(settings.timelapseMaxCount);
  const [totalGb, setTotalGb] = useState(settings.timelapseMaxTotalBytes / GB);
  const [fileMb, setFileMb] = useState(settings.artifactMaxBytes / MB);
  const [fileDays, setFileDays] = useState(settings.artifactRetentionDays);
  const [fileCount, setFileCount] = useState(settings.artifactMaxCount);
  const [fileTotalGb, setFileTotalGb] = useState(settings.artifactMaxTotalBytes / GB);
  const maxFileBytes = settings.artifactMaxBytesLimit;
  const maxFileMb = Math.floor(maxFileBytes / MB);
  const fileBytes = bytesOf(fileMb, MB);
  const fileTotalBytes = bytesOf(fileTotalGb, GB);
  const validFile = Number.isFinite(fileMb) && fileBytes >= MB && fileBytes <= maxFileBytes;
  const validFileDays = Number.isInteger(fileDays) && fileDays >= 0 && fileDays <= MAX_RETENTION_DAYS;
  const validFileCount = Number.isInteger(fileCount) && fileCount >= 0 && fileCount <= MAX_COUNT;
  const validFileTotal = Number.isFinite(fileTotalGb) && fileTotalGb >= 0;
  const maxVideoBytes = Math.min(MAX_VIDEO_BYTES, settings.timelapseMaxBytesLimit);
  const maxVideoMb = Math.floor(maxVideoBytes / MB);
  const videoBytes = bytesOf(videoMb, MB);
  const totalBytes = bytesOf(totalGb, GB);
  const validDays = Number.isInteger(days) && days >= 0 && days <= MAX_RETENTION_DAYS;
  const validVideo = Number.isFinite(videoMb) && videoBytes >= MIN_VIDEO_BYTES && videoBytes <= maxVideoBytes;
  const validCount = Number.isInteger(count) && count >= 0 && count <= MAX_COUNT;
  const validTotal = Number.isFinite(totalGb) && totalGb >= 0;
  const valid =
    validDays &&
    validVideo &&
    validCount &&
    validTotal &&
    validFile &&
    validFileDays &&
    validFileCount &&
    validFileTotal;
  const unchanged =
    enabled === settings.timelapseEnabled &&
    days === settings.timelapseRetentionDays &&
    videoBytes === settings.timelapseMaxBytes &&
    count === settings.timelapseMaxCount &&
    totalBytes === settings.timelapseMaxTotalBytes &&
    fileBytes === settings.artifactMaxBytes &&
    fileDays === settings.artifactRetentionDays &&
    fileCount === settings.artifactMaxCount &&
    fileTotalBytes === settings.artifactMaxTotalBytes;
  const save = useMutation({
    mutationFn: () =>
      updateRunRecordingSettings({
        timelapseEnabled: enabled,
        timelapseRetentionDays: days,
        timelapseMaxBytes: videoBytes,
        timelapseMaxCount: count,
        timelapseMaxTotalBytes: totalBytes,
        artifactMaxBytes: fileBytes,
        artifactRetentionDays: fileDays,
        artifactMaxCount: fileCount,
        artifactMaxTotalBytes: fileTotalBytes,
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
          helperText="0 keeps them until their run is deleted."

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
        <NumberInput
          id="timelapse-max-mb"
          label="Largest video (MB)"
          helperText={`Larger videos are not stored. At most ${formatFileSize(maxVideoBytes)}, the limit of this installation.`}
          min={1}
          max={maxVideoMb}
          step={10}
          allowEmpty
          value={Number.isNaN(videoMb) ? '' : videoMb}
          disabled={!canManage}
          invalid={!validVideo}
          invalidText={`Enter a size from 1 to ${maxVideoMb} MB.`}
          onChange={(_event, state) => setVideoMb(state.value === '' ? Number.NaN : Number(state.value))}
        />
        <NumberInput
          id="timelapse-max-count"
          label="Keep at most this many videos"
          helperText="0 means no limit. When there are more, the oldest videos are removed first."
          min={0}
          max={MAX_COUNT}
          step={1}
          allowEmpty
          value={Number.isNaN(count) ? '' : count}
          disabled={!canManage}
          invalid={!validCount}
          invalidText={`Enter a whole number from 0 to ${MAX_COUNT}.`}
          onChange={(_event, state) => setCount(state.value === '' ? Number.NaN : Number(state.value))}
        />
        <NumberInput
          id="timelapse-max-total-gb"
          label="Keep at most this much video (GB)"
          helperText="0 means no limit. When all videos together take more, the oldest are removed first."
          min={0}
          step={1}
          allowEmpty
          value={Number.isNaN(totalGb) ? '' : totalGb}
          disabled={!canManage}
          invalid={!validTotal}
          invalidText="Enter a size of 0 GB or more."
          onChange={(_event, state) => setTotalGb(state.value === '' ? Number.NaN : Number(state.value))}
        />
        <h3 className="mj-section-title">Print files</h3>
        <NumberInput
          id="artifact-max-mb"
          label="Largest print file (MB)"
          helperText={`Larger 3MF files are rejected. At most ${formatFileSize(maxFileBytes)}, the limit of this installation.`}
          min={1}
          max={maxFileMb}
          step={10}
          allowEmpty
          value={Number.isNaN(fileMb) ? '' : fileMb}
          disabled={!canManage}
          invalid={!validFile}
          invalidText={`Enter a size from 1 to ${maxFileMb} MB.`}
          onChange={(_event, state) => setFileMb(state.value === '' ? Number.NaN : Number(state.value))}
        />
        <NumberInput
          id="artifact-retention-days"
          label="Keep print files for (days)"
          helperText={
            '0 keeps them until their run is deleted. The oldest go first; a file a running print uses stays.'
          }
          min={0}
          max={MAX_RETENTION_DAYS}
          step={1}
          allowEmpty
          value={Number.isNaN(fileDays) ? '' : fileDays}
          disabled={!canManage}
          invalid={!validFileDays}
          invalidText={`Enter a whole number of days from 0 to ${MAX_RETENTION_DAYS}.`}
          onChange={(_event, state) => setFileDays(state.value === '' ? Number.NaN : Number(state.value))}
        />
        <NumberInput
          id="artifact-max-count"
          label="Keep at most this many print files"
          helperText={'0 means no limit. When there are more, the oldest go first; a file a running print uses stays.'}
          min={0}
          max={MAX_COUNT}
          step={1}
          allowEmpty
          value={Number.isNaN(fileCount) ? '' : fileCount}
          disabled={!canManage}
          invalid={!validFileCount}
          invalidText={`Enter a whole number from 0 to ${MAX_COUNT}.`}
          onChange={(_event, state) => setFileCount(state.value === '' ? Number.NaN : Number(state.value))}
        />
        <NumberInput
          id="artifact-max-total-gb"
          label="Keep at most this much print file data (GB)"
          helperText={
            '0 means no limit. Includes previews. When all files together take more, the oldest go first; a file a running print uses stays.'
          }
          min={0}
          step={1}
          allowEmpty
          value={Number.isNaN(fileTotalGb) ? '' : fileTotalGb}
          disabled={!canManage}
          invalid={!validFileTotal}
          invalidText={'Enter a size of 0 GB or more.'}
          onChange={(_event, state) => setFileTotalGb(state.value === '' ? Number.NaN : Number(state.value))}
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
            <Button disabled={!valid || unchanged || save.isPending} onClick={() => save.mutate()}>
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

/** Installation-wide settings for timelapse and print file collection and retention. */
export function RecordingSettingsTab() {
  const query = useQuery(recordingSettingsQuery());
  return (
    <QueryBoundary query={query} errorMessage="The recording settings could not be loaded.">
      {query.data && <SettingsForm key={query.data.version} settings={query.data} />}
    </QueryBoundary>
  );
}
