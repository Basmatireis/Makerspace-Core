import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

function mockKiosk(patch: Record<string, unknown>) {
  let calibrationOpen = true;
  const saved: Array<Record<string, unknown>> = [];
  let cancelled = 0;
  server.use(
    http.get('*/api/v1/terminal/context', () =>
      HttpResponse.json({
        deviceId: '0192f6f8-743e-7c77-a349-cd07c3e8a940',
        deviceName: 'Entrance',
        allowTapCheckout: true,
        offerSurveysAtCheckout: false,
        kioskResetSeconds: 60,
        checkInMethods: ['pin'],
        checkOutMethods: ['pin'],
        capabilities: ['camera'],
        staffDestination: 'login',
        notices: [],
        camera: { crop: null, indicator: { edge: 'right', offset: 30 }, mirror: false },
        cameraCalibrationExpiresAt: calibrationOpen ? new Date(Date.now() + 600_000).toISOString() : null,
        ...patch,
      }),
    ),
    http.get('*/api/v1/terminal/presence', () => HttpResponse.json({ items: [], count: 0 })),
    http.put('*/api/v1/terminal/camera-calibration', async ({ request }) => {
      saved.push((await request.json()) as Record<string, unknown>);
      calibrationOpen = false;
      return HttpResponse.json(saved.at(-1) ?? {});
    }),
    http.delete('*/api/v1/terminal/camera-calibration', () => {
      cancelled += 1;
      calibrationOpen = false;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return { saved, cancelled: () => cancelled };
}

function fakeCamera() {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop: vi.fn() }] }) },
  });
}

async function frameLoaded() {
  const video = await screen.findByLabelText('Whole camera image');
  Object.defineProperty(video, 'videoWidth', { value: 1280 });
  Object.defineProperty(video, 'videoHeight', { value: 720 });
  fireEvent.loadedMetadata(video);
}

describe('camera calibration on the kiosk', () => {
  afterEach(() => vi.restoreAllMocks());

  it('shows the calibration while staff opened a window and saves the crop and the lens pointer', async () => {
    fakeCamera();
    const { saved } = mockKiosk({});
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');

    expect(await screen.findByRole('heading', { name: 'Calibrate the camera' })).toBeInTheDocument();
    await frameLoaded();
    // The pointer is drawn live at the calibrated edge.
    expect(screen.getByTestId('camera-indicator')).toHaveClass('camera-indicator--right');
    expect(screen.getByTestId('calibration-crop').style.width).toBe('56.25%');
    const size = screen.getByRole('slider', { name: 'Square size (% of the shorter side)' });
    fireEvent.keyDown(size, { key: 'ArrowLeft' });
    await user.click(screen.getByText('Top'));
    expect(screen.getByTestId('camera-indicator')).toHaveClass('camera-indicator--top');
    await user.click(screen.getByRole('button', { name: 'Save calibration' }));

    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({
      crop: { centerX: 0.5, centerY: 0.5, size: 0.99 },
      indicator: { edge: 'top', offset: 30 },
      mirror: false,
    });
    // Saving closes the window: the kiosk returns to its start screen.
    expect(await screen.findByRole('button', { name: 'Check in' })).toBeInTheDocument();
  });

  it('mirrors the frame and the photo live, keeps the square in source coordinates and saves the flag', async () => {
    fakeCamera();
    const { saved } = mockKiosk({
      camera: { crop: { centerX: 0.7, centerY: 0.5, size: 0.5 }, indicator: null, mirror: false },
    });
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await frameLoaded();
    const crop = screen.getByTestId('calibration-crop');
    // Unmirrored: the 360 px square centred at 70 % of 1280 starts at 716 px.
    expect(parseFloat(crop.style.left)).toBeCloseTo((716 / 1280) * 100);
    expect(screen.getByLabelText('Whole camera image').style.transform).toBe('');

    await user.click(screen.getByRole('switch', { name: 'Mirror image' }));
    expect(screen.getByLabelText('Whole camera image').style.transform).toBe('scaleX(-1)');
    expect(screen.getByLabelText('Photo preview').style.transform).toBe('scaleX(-1)');
    // The square is drawn where it appears on the flipped frame.
    expect(parseFloat(screen.getByTestId('calibration-crop').style.left)).toBeCloseTo((204 / 1280) * 100);

    await user.click(screen.getByRole('button', { name: 'Save calibration' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]).toEqual({ crop: { centerX: 0.7, centerY: 0.5, size: 0.5 }, indicator: null, mirror: true });
  });

  it('drags the square to every edge of the full frame, also while mirrored', async () => {
    fakeCamera();
    const { saved } = mockKiosk({
      camera: { crop: { centerX: 0.5, centerY: 0.5, size: 0.5 }, indicator: null, mirror: true },
    });
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await frameLoaded();
    const box = screen.getByLabelText('Whole camera image').parentElement as HTMLElement;
    box.getBoundingClientRect = () => ({ width: 1280, height: 720, left: 0, top: 0 }) as DOMRect;
    box.setPointerCapture = () => undefined;
    // Dragging left on the mirrored screen moves the square towards the right of the source frame, up to its edge.
    fireEvent.pointerDown(box, { pointerId: 1, clientX: 600, clientY: 300 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: -2000, clientY: 5000 });
    fireEvent.pointerUp(box, { pointerId: 1 });
    // On screen the square touches the left edge and the bottom edge.
    expect(parseFloat(screen.getByTestId('calibration-crop').style.left)).toBe(0);
    expect(parseFloat(screen.getByTestId('calibration-crop').style.top)).toBeCloseTo(50);

    // The size slider reaches the full shorter side.
    const size = screen.getByRole('slider', { name: 'Square size (% of the shorter side)' });
    expect(size).toHaveAttribute('aria-valuemax', '100');
    await user.click(screen.getByRole('button', { name: 'Save calibration' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    // Source coordinates: the mirrored left edge is the source's right edge (centre 1280 - 180 px).
    expect(saved[0]).toMatchObject({ crop: { centerX: 1100 / 1280, centerY: 540 / 720 }, mirror: true });
  });

  it('cancels without saving', async () => {
    fakeCamera();
    const calls = mockKiosk({});
    const user = userEvent.setup();
    renderRoute(<App />, '/kiosk');
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('button', { name: 'Check in' })).toBeInTheDocument();
    expect(calls.cancelled()).toBe(1);
    expect(calls.saved).toHaveLength(0);
  });

  it('never calibrates a kiosk without a camera', async () => {
    mockKiosk({ capabilities: [] });
    renderRoute(<App />, '/kiosk');
    expect(await screen.findByRole('button', { name: 'Check in' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Calibrate the camera' })).not.toBeInTheDocument();
  });
});
