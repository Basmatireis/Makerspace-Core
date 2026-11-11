import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProfilePhotoPicker, type PhotoSources } from './ProfilePhotoPicker';

function renderPicker(sources: PhotoSources) {
  return render(<ProfilePhotoPicker image={undefined} sources={sources} required onChange={() => undefined} />);
}

describe('profile photo sources follow the kiosk capabilities', () => {
  it('offers the camera and the upload when the device has both', () => {
    renderPicker({ camera: true, upload: true });
    expect(screen.getByRole('button', { name: 'Start camera' })).toBeInTheDocument();
    expect(screen.getByLabelText('or upload a profile photo')).toBeInTheDocument();
  });

  it('offers only the camera without file_upload', () => {
    renderPicker({ camera: true, upload: false });
    expect(screen.getByRole('button', { name: 'Start camera' })).toBeInTheDocument();
    expect(screen.queryByLabelText(/upload a profile photo/i)).not.toBeInTheDocument();
  });

  it('offers only the upload without a camera', () => {
    renderPicker({ camera: false, upload: true });
    expect(screen.queryByRole('button', { name: 'Start camera' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Upload a profile photo')).toBeInTheDocument();
  });

  it('hides the photo picker entirely when the device offers neither', () => {
    const { container } = renderPicker({ camera: false, upload: false });
    expect(container).toBeEmptyDOMElement();
  });
});

type Draw = number[];

// A fake camera and canvas: getUserMedia yields a stream, drawImage records the source rectangle.
function fakeCamera() {
  const stop = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
  });
  const draws: Draw[] = [];
  const canvases: Array<{ width: number; height: number }> = [];
  const realCreate = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation((tag: string, options?: ElementCreationOptions) => {
    const element = realCreate(tag, options);
    if (tag === 'canvas') {
      canvases.push(element as HTMLCanvasElement);
      (element as HTMLCanvasElement).getContext = (() => ({
        drawImage: (...args: number[]) => draws.push(args.slice(1)),
      })) as unknown as HTMLCanvasElement['getContext'];
      (element as HTMLCanvasElement).toDataURL = () => 'data:image/jpeg;base64,AAAA';
    }
    return element;
  });
  return { stop, draws, canvases };
}

async function startPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Start camera' }));
  const video = (await screen.findByLabelText('Camera preview')) as HTMLVideoElement;
  Object.defineProperty(video, 'videoWidth', { value: 1280 });
  Object.defineProperty(video, 'videoHeight', { value: 720 });
  fireEvent.loadedMetadata(video);
  return video;
}

describe('camera capture', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('counts down 3-2-1 over an unmirrored preview, announces it and captures the centred square of the frame', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { stop, draws, canvases } = fakeCamera();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPicker({ camera: true, upload: false });
    const video = await startPreview(user);
    expect(video.style.transform).not.toContain('scaleX');
    expect(document.querySelector('.visitor-photo__guide')).not.toBeNull();

    await user.click(screen.getByRole('button', { name: 'Take photo' }));
    expect(screen.getByText('Taking the photo in 3')).toHaveAttribute('aria-live', 'assertive');
    expect(document.querySelector('.camera-countdown__number')).toHaveTextContent('3');
    expect(screen.queryByRole('button', { name: 'Take photo' })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(document.querySelector('.camera-countdown__number')).toHaveTextContent('2');
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(screen.getByText('Taking the photo in 1')).toBeInTheDocument();
    expect(draws).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(1000));

    await waitFor(() => expect(draws).toHaveLength(1));
    expect(canvases[0]).toMatchObject({ width: 720, height: 720 });
    // Source rectangle: the centred 720 px square of the 1280x720 frame.
    expect(draws[0]).toEqual([280, 0, 720, 720, 0, 0, 720, 720]);
    expect(stop).toHaveBeenCalled();
  });

  it('cancels the countdown without taking a photo', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { draws } = fakeCamera();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPicker({ camera: true, upload: false });
    await startPreview(user);
    await user.click(screen.getByRole('button', { name: 'Take photo' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await act(() => vi.advanceTimersByTimeAsync(4000));
    expect(draws).toHaveLength(0);
    expect(screen.getByRole('button', { name: 'Take photo' })).toBeInTheDocument();
    expect(document.querySelector('.camera-countdown')).toBeNull();
  });

  it('previews and captures the calibrated square and points at the lens while the camera is live', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { draws } = fakeCamera();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(
      <ProfilePhotoPicker
        image={undefined}
        sources={{ camera: true, upload: false }}
        required
        camera={{ crop: { centerX: 0.7, centerY: 0.5, size: 0.5 }, indicator: { edge: 'top', offset: 62.5 } }}
        onChange={() => undefined}
      />,
    );
    const indicator = screen.getByTestId('camera-indicator');
    expect(indicator).not.toHaveClass('camera-indicator--live');
    expect(indicator.style.left).toBe('62.5%');
    const video = await startPreview(user);
    expect(screen.getByTestId('camera-indicator')).toHaveClass('camera-indicator--live');
    // The preview shows exactly the calibrated 360 px square starting at (716, 180).
    expect(parseFloat(video.style.insetInlineStart)).toBeCloseTo((-716 / 360) * 100);
    expect(parseFloat(video.style.insetBlockStart)).toBeCloseTo(-50);
    await user.click(screen.getByRole('button', { name: 'Take photo' }));
    await act(() => vi.advanceTimersByTimeAsync(3000));
    await waitFor(() => expect(draws).toHaveLength(1));
    expect(draws[0]).toEqual([716, 180, 360, 360, 0, 0, 360, 360]);
  });
});
