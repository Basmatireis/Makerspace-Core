import {
  getDownloadMachineRunArtifactUrl,
  getGetMachineRunPreviewUrl,
} from '../../../api/generated/machine-runs/machine-runs';
import type { MachineRunPreview, MachineRunRecording } from '../../../api/generated/models';
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

/**
 * One image per plate of a print file. Slicers embed several renders of each plate (full size, a small copy and
 * helper images such as the object pick map); plate renders win over other images, then the largest, then the
 * first in archive order. Other images are kept only for a file without any plate render.
 */
export function plateImages(previews: MachineRunPreview[]): MachineRunPreview[] {
  const hasPlates = previews.some((preview) => preview.role === 'plate');
  // Unlit renders (plate_no_light_N.png) carry no parsed plate number; numbered plate renders replace them.
  const hasNumberedPlates = previews.some((preview) => preview.role === 'plate' && preview.plateNumber != null);
  const best = new Map<string, MachineRunPreview>();
  for (const preview of previews) {
    if (hasPlates && preview.role !== 'plate') continue;
    if (hasNumberedPlates && preview.plateNumber == null) continue;
    const key = String(preview.plateNumber ?? 'none');
    const current = best.get(key);
    if (!current || preview.width * preview.height > current.width * current.height) best.set(key, preview);
  }
  return previews.filter((preview) => best.get(String(preview.plateNumber ?? 'none')) === preview);
}

/** The previews of recorded runs, in run order, one per plate. Runs without a 3MF contribute none. */
export function thumbnailsOf(recordings: MachineRunRecording[], labelWithRun: boolean): Thumbnail[] {
  return recordings.flatMap((recording) =>
    plateImages(recording.previews).map((preview) => ({
      id: preview.id,
      src: getGetMachineRunPreviewUrl(recording.runId, preview.id),
      label: previewLabel(preview),
      fileName: recording.artifact?.originalFilename ?? recording.runDisplayId,
      runDisplayId: labelWithRun ? recording.runDisplayId : undefined,
      downloadHref: recording.artifact ? getDownloadMachineRunArtifactUrl(recording.runId) : undefined,
    })),
  );
}
