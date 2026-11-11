import { describe, expect, it, vi } from 'vitest';
import { kioskCameraConstraints, openKioskCamera } from './cameraStream';

describe('kiosk camera constraints', () => {
  it('ask for the largest native mode of the front camera without cropping or scaling it', () => {
    expect(kioskCameraConstraints.audio).toBe(false);
    expect(kioskCameraConstraints.video).toMatchObject({
      facingMode: 'user',
      width: { ideal: 4096 },
      height: { ideal: 4096 },
      resizeMode: 'none',
    });
  });

  it('are the only constraints a camera is opened with', async () => {
    const getUserMedia = vi.fn(async () => ({}) as MediaStream);
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    await openKioskCamera();
    expect(getUserMedia).toHaveBeenCalledWith(kioskCameraConstraints);
  });
});
