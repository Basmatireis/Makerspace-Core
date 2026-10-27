import { Accordion, AccordionItem, Button, InlineNotification, Tag, Tile } from '@carbon/react';
import { Download } from '@carbon/icons-react';
import {
  getDownloadMachineRunArtifactUrl,
  getDownloadMachineRunTimelapseUrl,
} from '../../../api/generated/machine-runs/machine-runs';
import type { MachineRunRecording } from '../../../api/generated/models';
import { formatDateTime } from '../shared/format';
import { PrintPreview } from './PrintPreview';
import { thumbnailsOf } from './thumbnails';
import { formatFileSize, timelapseMessage } from './recordingText';
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

/** Preview and print file of one run. */
export function RunPreviewTile({
  recording,
  recorded,
  loading,
  failed,
}: {
  recording: MachineRunRecording | undefined;
  recorded: boolean;
  loading: boolean;
  failed: boolean;
}) {
  return (
    <Tile>
      <h3 className="mj-section-title">Preview</h3>
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
        <PrintPreview
          thumbnails={recording ? thumbnailsOf([recording], false) : []}
          emptyText={
            recorded
              ? recording?.artifact
                ? 'The print file contains no preview image.'
                : 'Core has no print file for this run, so there is no preview.'
              : 'Manual runs have no print file, so there is no preview.'
          }
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
    </Tile>
  );
}

/** Timelapse of one run, or the reason there is none. Hidden for manual runs. */
export function RunTimelapseTile({ recording }: { recording: MachineRunRecording }) {
  const message = recording.timelapse ? null : timelapseMessage(recording.timelapseStatus);
  return (
    <Tile>
      <h3 className="mj-section-title">Timelapse</h3>
      {recording.timelapse ? (
        <TimelapseVideo recording={recording} />
      ) : (
        message && (
          <InlineNotification
            kind={recording.timelapseStatus?.state === 'failed' ? 'warning' : 'info'}
            lowContrast
            hideCloseButton
            title={message.title}
            subtitle={message.message}
          />
        )
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
