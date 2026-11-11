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
        camera: { crop: null, indicator: { edge: 'right', offset: 30 } },
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
    });
    // Saving closes the window: the kiosk returns to its start screen.
    expect(await screen.findByRole('button', { name: 'Check in' })).toBeInTheDocument();
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
