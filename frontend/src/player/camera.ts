import type { ReactNode } from 'react';
import type { SignagePlayerLive } from '../api/generated/models';
import type { RenderMachine } from '../features/signage/render/types';

/**
 * Where camera pictures come from. `cameraManager.tsx` supplies the WebRTC/MSE implementation fed by the stream tickets
 * in the live data; `noCameraSource` (no machine has a stream) makes camera widgets show their configured fallback.
 */
export interface CameraSource {
  /** True when a stream can be shown for the machine right now (offered by Core and not failed). */
  hasStream(machineId: string): boolean;
  /** The picture to show inside the camera frame; null keeps the neutral frame. */
  view(machine: RenderMachine): ReactNode;
  /** Receives the streams of every live poll (tickets are refreshed this way). */
  setStreams?(streams: LiveStreams): void;
  /** Called when the availability of a picture changed, so the view can be resolved again. */
  subscribe?(listener: () => void): () => void;
  /** Where problems go (they reach the display's heartbeat); never contains tickets. */
  setErrorSink?(sink: (message: string) => void): void;
  /** Closes every connection (the source stays usable). */
  dispose?(): void;
}

/** Streams offered by the latest live response. */
export type LiveStreams = SignagePlayerLive['streams'];

export const noCameraSource: CameraSource = { hasStream: () => false, view: () => null };
