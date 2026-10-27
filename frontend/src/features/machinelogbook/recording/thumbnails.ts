import {
  getDownloadMachineRunArtifactUrl,
  getGetMachineRunPreviewUrl,
} from '../../../api/generated/machine-runs/machine-runs';
import type { MachineRunRecording } from '../../../api/generated/models';
import { previewLabel } from './recordingText';

export type Thumbnail = {
  id: string;
  src: string;
  label: string;
  fileName: string;
  /** Set on job pages, where previews of several runs share one viewer. */
  runDisplayId?: string;
  /** Link to the print file this preview belongs to. */
  downloadHref?: string;
};

/** The previews of recorded runs, in run order (plates first within a run). Runs without a 3MF contribute none. */
export function thumbnailsOf(recordings: MachineRunRecording[], labelWithRun: boolean): Thumbnail[] {
  return recordings.flatMap((recording) =>
    recording.previews.map((preview) => ({
      id: preview.id,
      src: getGetMachineRunPreviewUrl(recording.runId, preview.id),
      label: previewLabel(preview),
      fileName: recording.artifact?.originalFilename ?? recording.runDisplayId,
      runDisplayId: labelWithRun ? recording.runDisplayId : undefined,
      downloadHref: recording.artifact ? getDownloadMachineRunArtifactUrl(recording.runId) : undefined,
    })),
  );
}
