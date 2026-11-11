import { describe, expect, it, vi } from 'vitest';
import { kioskCameraConstraints, openKioskCamera } from './cameraStream';

describe('kiosk camera constraints', () => {
  it('ask for the largest native mode of the front camera without cropping or scaling it', () => {
    expect(kioskCameraConstraints.audio).toBe(false);
    expect(kioskCameraConstraints.video).toMatchObject({
      facingMode: 'user',
      width: { ideal: 4096 },
      resizeMode: 'none',
    });
    // A height would also ask for an aspect ratio, which Safari crops the sensor image to.
    expect(kioskCameraConstraints.video).not.toHaveProperty('height');
  });

  it('move the track to the largest size the camera reports', async () => {
    const applyConstraints = vi.fn(async () => undefined);
    const track = { getCapabilities: () => ({ width: { max: 2592 }, height: { max: 1944 } }), applyConstraints };
    const getUserMedia = vi.fn(async () => ({ getVideoTracks: () => [track] }) as unknown as MediaStream);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    await openKioskCamera();
    expect(applyConstraints).toHaveBeenCalledWith(
      expect.objectContaining({ width: { ideal: 2592 }, height: { ideal: 1944 } }),
    );
  });

  it('are the only constraints a camera is opened with', async () => {
    const getUserMedia = vi.fn(async () => ({}) as MediaStream);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    await openKioskCamera();
    expect(getUserMedia).toHaveBeenCalledWith(kioskCameraConstraints);
  });
});
