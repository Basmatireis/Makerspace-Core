import { render, screen, waitFor } from '@testing-library/react';
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

describe('camera capture', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows an unmirrored preview with a face guide and captures the centred square of the frame', async () => {
    const stop = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop }] }) },
    });
    const draws: number[][] = [];
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
    const user = userEvent.setup();
    renderPicker({ camera: true, upload: false });
    await user.click(screen.getByRole('button', { name: 'Start camera' }));

    const video = (await screen.findByLabelText('Camera preview')) as HTMLVideoElement;
    expect(video.style.transform).not.toContain('scaleX');
    expect(document.querySelector('.visitor-photo__guide')).not.toBeNull();
    Object.defineProperty(video, 'videoWidth', { value: 1280 });
    Object.defineProperty(video, 'videoHeight', { value: 720 });
    await user.click(screen.getByRole('button', { name: 'Take photo' }));

    await waitFor(() => expect(draws).toHaveLength(1));
    expect(canvases[0]).toMatchObject({ width: 720, height: 720 });
    // Source rectangle: the centred 720 px square of the 1280x720 frame.
    expect(draws[0]).toEqual([280, 0, 720, 720, 0, 0, 720, 720]);
    expect(stop).toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
