import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { assetFixture, ids, mockSignage } from './testFixtures';

describe('Media page', () => {
  it('lists media with usage and opens the details read-only', async () => {
    mockSignage([PermissionId.signageread]);
    renderRoute(<App />, '/signage/media');
    const user = userEvent.setup();
    const tile = await screen.findByRole('button', { name: 'poster.png, details' });
    expect(within(tile).getByText('1080 × 1920 · 2.0 MB')).toBeInTheDocument();
    expect(await within(tile).findByText('Used in 1 scene')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Upload' })).not.toBeInTheDocument();
    await user.click(tile);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('image/png')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Open days poster' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Delete media' })).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('filters by type and search', async () => {
    mockSignage([PermissionId.signageread], { assets: [assetFixture(), assetFixture({ id: ids.video, kind: 'video', name: 'intro.mp4', contentType: 'video/mp4', durationMs: 90_000 })] });
    renderRoute(<App />, '/signage/media');
    const user = userEvent.setup();
    expect(await screen.findByRole('button', { name: 'intro.mp4, details' })).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Type'), 'image');
    expect(screen.queryByRole('button', { name: 'intro.mp4, details' })).not.toBeInTheDocument();
    await user.type(screen.getByRole('searchbox'), 'nothing');
    expect(await screen.findByText('No media found')).toBeInTheDocument();
  });

  it('uploads an image as raw bytes with the expected headers', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let headers: Headers | undefined;
    server.use(http.post('*/api/v1/signage/assets', async ({ request }) => { headers = request.headers;  return HttpResponse.json(assetFixture({ name: 'new.png' }), { status: 201 }); }));
    renderRoute(<App />, '/signage/media');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Upload' }));
    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array(1234)], 'Plakat ü.png', { type: 'image/png' }));
    await user.click(within(dialog).getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(headers).toBeDefined());
    expect(headers?.get('content-type')).toBe('application/octet-stream');
    expect(headers?.get('x-file-name')).toBe(encodeURIComponent('Plakat ü.png'));
    expect(headers?.get('x-file-content-type')).toBe('image/png');
  });

  it('sends ASCII names encoded and strips control characters', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    let name: string | null | undefined;
    server.use(http.post('*/api/v1/signage/assets', async ({ request }) => { name = request.headers.get('x-file-name'); return HttpResponse.json(assetFixture(), { status: 201 }); }));
    renderRoute(<App />, '/signage/media');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Upload' }));
    const dialog = await screen.findByRole('dialog');
    await user.upload(dialog.querySelector('input[type="file"]') as HTMLInputElement, new File([new Uint8Array(10)], '100% done – 日本.png', { type: 'image/png' }));
    await user.click(within(dialog).getByRole('button', { name: 'Upload' }));
    await waitFor(() => expect(name).toBeDefined());
    expect(decodeURIComponent(name ?? '')).toBe('100% done – 日本.png');
    expect(name).toMatch(/^[\x20-\x7e]+$/);
  });

  it('shows the uploader and requests thumbnails with the content digest', async () => {
    mockSignage([PermissionId.signageread]);
    renderRoute(<App />, '/signage/media');
    const user = userEvent.setup();
    const tile = await screen.findByRole('button', { name: 'poster.png, details' });
    expect(tile.querySelector('img')?.getAttribute('src')).toContain(`/content?v=${'a'.repeat(64)}`);
    await user.click(tile);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Uploaded by')).toBeInTheDocument();
    expect(within(dialog).getByText('Ada Lovelace')).toBeInTheDocument();
    expect(dialog.querySelector('img')?.getAttribute('src')).toContain(`v=${'a'.repeat(64)}`);
  });

  it('shows Unknown when the uploader account no longer exists', async () => {
    mockSignage([PermissionId.signageread], { assets: [assetFixture({ createdByName: null })] });
    renderRoute(<App />, '/signage/media');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'poster.png, details' }));
    expect(within(await screen.findByRole('dialog')).getByText('Unknown')).toBeInTheDocument();
  });

  it('rejects oversized files before uploading', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    renderRoute(<App />, '/signage/media');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Upload' }));
    const dialog = await screen.findByRole('dialog');
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    const big = new File(['x'], 'huge.png', { type: 'image/png' });
    Object.defineProperty(big, 'size', { value: 30 << 20 });
    await user.upload(input, big);
    expect(await within(dialog).findByText('Too large (limit 20.0 MB)')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Upload' })).toBeDisabled();
  });

  it('lists the scenes that block deleting media (409)', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagecontentmanage]);
    server.use(http.delete('*/api/v1/signage/assets/:id', () => HttpResponse.json({ code: 'signage_in_use', message: 'in use', details: { references: [{ kind: 'scene', id: ids.scene, name: 'Open days poster' }] } }, { status: 409 })));
    renderRoute(<App />, '/signage/media');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'poster.png, details' }));
    await user.click(await screen.findByRole('button', { name: 'Delete media' }));
    await user.click(await screen.findByRole('button', { name: 'Delete media' }));
    const dialog = await screen.findByRole('dialog');
    expect(await within(dialog).findByRole('link', { name: 'Open days poster' })).toHaveAttribute('href', `/signage/scenes/${ids.scene}`);
  });
});
