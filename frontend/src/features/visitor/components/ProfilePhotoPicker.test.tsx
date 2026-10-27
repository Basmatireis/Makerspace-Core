import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
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
