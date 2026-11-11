/**
 * The one set of camera constraints for the kiosk, shared by the visitor wizard and the calibration screen so a
 * calibration is made on exactly the image the wizard later shows.
 *
 * Without a resolution, browsers open a small default mode (often 640×480) that many tablet cameras serve from a
 * cropped or binned part of the sensor, which narrows the field of view. Only the width is asked for: a width and a
 * height together also ask for their aspect ratio, and browsers that crop to fit (Safari, so every iPad) then cut the
 * sensor image down to it — 4096×4096 gave a square. `resizeMode: 'none'` (Chrome) forbids cropping or scaling the
 * native mode. After opening, the track is moved to its largest native size where the browser reports capabilities.
 */
export const kioskCameraConstraints: MediaStreamConstraints = {
  video: {
    facingMode: 'user',
    width: { ideal: 4096 },
    // Part of the Media Capture spec Chrome implements, but missing from TypeScript's lib typings.
    resizeMode: 'none',
  } as MediaTrackConstraints,
  audio: false,
};

export async function openKioskCamera(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia(kioskCameraConstraints);
  const [track] = stream.getVideoTracks?.() ?? [];
  const capabilities = track?.getCapabilities?.();
  if (track && capabilities?.width?.max && capabilities.height?.max) {
    // `ideal` never rejects; a camera without a mode of exactly this size picks its closest native one.
    await track
      .applyConstraints({
        width: { ideal: capabilities.width.max },
        height: { ideal: capabilities.height.max },
        resizeMode: 'none',
      } as MediaTrackConstraints)
      .catch(() => undefined);
  }
  return stream;
}
