import type { ReactNode } from 'react';
import type { SignagePlayerLive } from '../api/generated/models';
import type { RenderMachine } from '../features/signage/render/types';

/**
 * Where camera pictures come from. Phase 5 supplies a WebRTC/MSE implementation fed by the stream tickets in the live
 * data; until then no machine has a stream, so camera widgets show their configured fallback.
 */
export interface CameraSource {
  /** True when a stream can be shown for the machine right now. */
  hasStream(machineId: string): boolean;
  /** The picture to show inside the camera frame; null keeps the neutral frame. */
  view(machine: RenderMachine): ReactNode;
}

/** Streams offered by the latest live response (always empty until the streaming gateway exists). */
export type LiveStreams = SignagePlayerLive['streams'];

export const noCameraSource: CameraSource = { hasStream: () => false, view: () => null };
