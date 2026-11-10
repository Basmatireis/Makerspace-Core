import { useState } from 'react';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { MediaPicker } from './MediaPicker';
import { assetFixture, ids, mockSignage } from './testFixtures';
import { PermissionId } from '../../api/generated/models';

const auth = { permissions: [] as string[] };
vi.mock('../auth/auth', () => ({
  useCurrentUser: () => ({ permissions: auth.permissions, authentication: { reauthenticationRequired: [] } }),
}));

const second = '0190c0a0-0000-7000-8000-0000000000b2';

function Harness({ kind = 'image' as 'image' | 'video', allowNone = false }) {
  const [value, setValue] = useState<string | null>(null);
  return (
    <>
      <MediaPicker id="pick" labelText="Image" kind={kind} value={value} onChange={setValue} allowNone={allowNone} />
      <output data-testid="value">{value ?? 'none'}</output>
    </>
  );
}

function setup(permissions: PermissionId[], assets = [assetFixture(), assetFixture({ id: second, name: 'logo.png' })]) {
  auth.permissions = permissions;
  mockSignage(permissions, { assets: [...assets, assetFixture({ id: ids.scene, kind: 'video', name: 'clip.mp4' })] });
}

describe('MediaPicker', () => {
  it('lists the assets of its kind and selects one', async () => {
    setup([PermissionId.signageread]);
    renderRoute(<Harness />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'Image' }));
    expect(screen.queryByRole('option', { name: 'clip.mp4' })).not.toBeInTheDocument();
    await user.click(await screen.findByRole('option', { name: 'logo.png' }));
    expect(screen.getByTestId('value')).toHaveTextContent(second);
  });

  it('hides the upload entry without signage.content.manage', async () => {
    setup([PermissionId.signageread]);
    renderRoute(<Harness />);
    await userEvent.setup().click(await screen.findByRole('combobox', { name: 'Image' }));
    expect(await screen.findByRole('option', { name: 'poster.png' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Upload an image…' })).not.toBeInTheDocument();
  });

  it('offers None when allowed', async () => {
    setup([PermissionId.signageread]);
    renderRoute(<Harness allowNone />);
    await userEvent.setup().click(await screen.findByRole('combobox', { name: 'Image' }));
    expect(await screen.findByRole('option', { name: 'None' })).toBeInTheDocument();
  });

  it('uploads a new image, refreshes the list and selects it', async () => {
    setup([PermissionId.signageread, PermissionId.signagecontentmanage]);
    const created = assetFixture({ id: '0190c0a0-0000-7000-8000-0000000000c3', name: 'new.png' });
    let headers: Headers | undefined;
    server.use(
      http.post('*/api/v1/signage/assets', ({ request }) => {
        headers = request.headers;
        server.use(http.get('*/api/v1/signage/assets', () => HttpResponse.json({ items: [assetFixture(), created] })));
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    renderRoute(<Harness />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'Image' }));
    await user.click(await screen.findByRole('option', { name: 'Upload an image…' }));
    await user.upload(
      screen.getByTestId('pick-file'),
      new File([new Uint8Array(10)], 'new.png', { type: 'image/png' }),
    );
    await waitFor(() => expect(screen.getByTestId('value')).toHaveTextContent(created.id));
    expect(headers?.get('x-file-content-type')).toBe('image/png');
    expect(screen.getByRole('combobox', { name: 'Image' })).toHaveTextContent('new.png');
  });

  it('refuses files of the wrong type without uploading', async () => {
    setup([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let posted = false;
    server.use(
      http.post('*/api/v1/signage/assets', () => {
        posted = true;
        return HttpResponse.json(assetFixture(), { status: 201 });
      }),
    );
    renderRoute(<Harness />);
    await screen.findByRole('combobox', { name: 'Image' });
    // The file chooser's accept filter does not apply to programmatic uploads, so the picker checks the type itself.
    await userEvent
      .setup({ applyAccept: false })
      .upload(screen.getByTestId('pick-file'), new File(['x'], 'clip.mp4', { type: 'video/mp4' }));
    expect(await screen.findByText(/That file is not an image/)).toBeInTheDocument();
    expect(posted).toBe(false);
  });

  it('shows the server error of a failed upload', async () => {
    setup([PermissionId.signageread, PermissionId.signagecontentmanage]);
    server.use(
      http.post('*/api/v1/signage/assets', () =>
        HttpResponse.json({ code: 'asset_too_large', message: 'The file is too large' }, { status: 413 }),
      ),
    );
    renderRoute(<Harness />);
    await screen.findByRole('combobox', { name: 'Image' });
    await userEvent.setup().upload(screen.getByTestId('pick-file'), new File(['x'], 'big.png', { type: 'image/png' }));
    const alert = await screen.findByText('Upload failed');
    expect(
      within(alert.closest('[role="status"], [role="alert"]') as HTMLElement).getByText(/too large/i),
    ).toBeVisible();
  });
});
