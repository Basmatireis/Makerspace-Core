/**
 * The one set of camera constraints for the kiosk, shared by the visitor wizard and the calibration screen so a
 * calibration is made on exactly the image the wizard later shows.
 *
 * Without a resolution, browsers open a small default mode (often 640×480) that many tablet cameras serve from a
 * cropped or binned part of the sensor, which narrows the field of view. Asking for an ideal of 4096×4096 makes the
 * browser pick the largest mode the camera offers, which is its full-sensor mode, without hard-failing (`ideal` never
 * rejects) on cameras that top out lower. That is more robust than hard-coding 1920×1080, a 16:9 mode that is usually a
 * crop of a 4:3 sensor, and than reading `getCapabilities()` first, which not every browser implements and which can
 * name a maximum width and height that no single mode combines. `resizeMode: 'none'` (Chrome) forbids the browser from
 * cropping or scaling the native mode to fit the request.
 */
export const kioskCameraConstraints: MediaStreamConstraints = {
  video: {
    facingMode: 'user',
    width: { ideal: 4096 },
    height: { ideal: 4096 },
    // Part of the Media Capture spec Chrome implements, but missing from TypeScript's lib typings.
    resizeMode: 'none',
  } as MediaTrackConstraints,
  audio: false,
};

export function openKioskCamera(): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia(kioskCameraConstraints);
}
