import { Camera } from '@carbon/icons-react';
import type { KioskCameraIndicator } from '../../../api/generated/models';
import { indicatorPlacement } from './cameraCrop';
import './camera.scss';

/**
 * A notch at the screen edge right next to the tablet's camera lens, so people look into it. It appears only where a
 * photo is taken (and while calibrating): quiet while the camera is off, red and pulsing while it is live.
 * It is never shown on the start screen, so it never suggests a camera is watching when none is on.
 */
export function CameraIndicator({
  indicator,
  live,
}: {
  indicator: KioskCameraIndicator | null | undefined;
  live: boolean;
}) {
  if (!indicator) return null;
  return (
    <div
      className={`camera-indicator camera-indicator--${indicator.edge}${live ? ' camera-indicator--live' : ''}`}
      style={indicatorPlacement(indicator)}
      data-testid="camera-indicator"
      aria-hidden="true"
    >
      <span className="camera-indicator__pill">
        <Camera size={24} />
      </span>
    </div>
  );
}
