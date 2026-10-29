import { useState, type ReactNode } from 'react';
import {
  Accordion,
  AccordionItem,
  Button,
  ContentSwitcher,
  InlineNotification,
  Switch,
  Tag,
  Tile,
} from '@carbon/react';
import { Download } from '@carbon/icons-react';
import {
  getDownloadMachineRunArtifactUrl,
  getDownloadMachineRunTimelapseUrl,
} from '../../../api/generated/machine-runs/machine-runs';
import type { MachineRunRecording } from '../../../api/generated/models';
import { formatDateTime } from '../shared/format';
import { PrintPreview } from './PrintPreview';
import { thumbnailsOf } from './thumbnails';
import { formatFileSize, internalStorageMessage, isOnInternalStorage, timelapseMessage } from './recordingText';
import './recording.scss';

/** The video and its download; preload stays off so opening a page never transfers the file. */
function TimelapseVideo({ recording }: { recording: MachineRunRecording }) {
  const { runId, runDisplayId, timelapse } = recording;
  if (!timelapse) return null;
  const href = getDownloadMachineRunTimelapseUrl(runId);
  return (
    <div className="mj-stack">
      {/* The printer's timelapse has no audio or speech, so there is nothing to caption. */}
      <video
        className="recording-video"
        controls
        preload="none"
        src={href}
        aria-label={`Timelapse of ${runDisplayId}`}
      />
      <div className="recording-actions">
        <Button kind="tertiary" size="sm" renderIcon={Download} href={href}>
          Download timelapse
        </Button>
        <span className="mj-secondary">
          {formatFileSize(timelapse.sizeBytes)}
          {timelapse.expiresAt ? ` · kept until ${formatDateTime(timelapse.expiresAt)}` : ''}
        </span>
      </div>
    </div>
  );
}

/**
 * Preview and print file of one run. A small gallery: the print file's preview image and, when the run has one, the
 * timelapse as a second item. A pending or missing timelapse shows as a compact line below the preview.
 */
export function RunPreviewTile({
  recording,
  recorded,
  loading,
  failed,
  uploadAction,
}: {
  recording: MachineRunRecording | undefined;
  recorded: boolean;
  loading: boolean;
  failed: boolean;
  /** Upload control for a run without a print file; shown in the empty state only. */
  uploadAction?: ReactNode;
}) {
  const [item, setItem] = useState<'preview' | 'timelapse'>('preview');
  const hasVideo = Boolean(recording?.timelapse);
  const timelapse = recorded && recording && !hasVideo ? timelapseMessage(recording.timelapseStatus) : null;
  return (
    <Tile>
      <h3 className="mj-section-title">{hasVideo ? 'Preview and timelapse' : 'Preview'}</h3>
      {failed ? (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Preview unavailable"
          subtitle="The print file information could not be loaded."
        />
      ) : loading ? (
        <p className="mj-secondary">Loading the preview…</p>
      ) : (
        <div className="mj-stack">
          {hasVideo && (
            <ContentSwitcher
              size="sm"
              selectedIndex={item === 'preview' ? 0 : 1}
              onChange={({ name }) => setItem(name === 'timelapse' ? 'timelapse' : 'preview')}
            >
              <Switch name="preview" text="Preview" />
              <Switch name="timelapse" text="Timelapse" />
            </ContentSwitcher>
          )}
          {item === 'timelapse' && recording && hasVideo ? (
            <TimelapseVideo recording={recording} />
          ) : (
            <PrintPreview
              thumbnails={recording ? thumbnailsOf([recording], false) : []}
              emptyText={
                recorded
                  ? recording?.artifact
                    ? 'The print file contains no preview image.'
                    : isOnInternalStorage(recording?.consumptionStatus)
                      ? internalStorageMessage
                      : 'Core has no print file for this run, so there is no preview.'
                  : 'Manual runs have no print file, so there is no preview.'
              }
              emptyAction={recorded && recording && !recording.artifact ? uploadAction : undefined}
              emptyDownload={
                recording?.artifact
                  ? {
                      href: getDownloadMachineRunArtifactUrl(recording.runId),
                      fileName: recording.artifact.originalFilename,
                    }
                  : undefined
              }
            />
          )}
          {timelapse && (
            <p className="mj-secondary">
              <strong>{timelapse.title}</strong> · <span>{timelapse.message}</span>
            </p>
          )}
        </div>
      )}
    </Tile>
  );
}

/** Previews of all runs of a job in one viewer, labelled with the run; the download offers the shown preview's print file. */
export function JobPreviewTile({ recordings }: { recordings: MachineRunRecording[] }) {
  const thumbnails = thumbnailsOf(recordings, true);
  const files = recordings.filter((recording) => recording.artifact);
  return (
    <Tile>
      <div className="recording-tile__heading">
        <h3 className="mj-section-title">{thumbnails.length > 1 ? 'Previews' : 'Preview'}</h3>
        {thumbnails.length > 1 && (
          <Tag size="sm" type="gray">
            {thumbnails.length} images
          </Tag>
        )}
      </div>
      <PrintPreview
        thumbnails={thumbnails}
        emptyText="None of this job’s runs has a print file with a preview."
        emptyDownload={
          files[0]?.artifact
            ? { href: getDownloadMachineRunArtifactUrl(files[0].runId), fileName: files[0].artifact.originalFilename }
            : undefined
        }
      />
    </Tile>
  );
}

/** Timelapses of the job's runs, one disclosure per run that has a video. Nothing when no run has one. */
export function JobTimelapseTile({ recordings }: { recordings: MachineRunRecording[] }) {
  const withVideo = recordings.filter((recording) => recording.timelapse);
  if (withVideo.length === 0) return null;
  return (
    <Tile>
      <h3 className="mj-section-title">{withVideo.length > 1 ? 'Timelapses' : 'Timelapse'}</h3>
      <Accordion>
        {withVideo.map((recording) => (
          <AccordionItem key={recording.runId} title={recording.runDisplayId} open={withVideo.length === 1}>
            <TimelapseVideo recording={recording} />
          </AccordionItem>
        ))}
      </Accordion>
    </Tile>
  );
}
