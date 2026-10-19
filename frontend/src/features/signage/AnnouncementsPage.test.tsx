import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { announcementFixture, displayFixture, ids, mockSignage } from './testFixtures';

describe('Announcements page', () => {
  it('lists active and scheduled announcements without write controls for readers', async () => {
    const later = new Date(Date.now() + 86_400_000).toISOString();
    mockSignage([PermissionId.signageread], { displays: [displayFixture()], announcements: [announcementFixture(), announcementFixture({ id: ids.scene2, status: 'scheduled', startsAt: later, allDisplays: false, displayIds: [ids.display] })] });
    renderRoute(<App />, '/signage/announcements');
    expect(await screen.findByRole('table', { name: 'Active' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Scheduled' })).toBeInTheDocument();
    expect(screen.getAllByText('Closed today – Holiday').length).toBe(2);
    expect(screen.getByText('All displays')).toBeInTheDocument();
    expect(screen.getByText('Until stopped')).toBeInTheDocument();
    expect(screen.getByText('1 active · 1 scheduled')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New announcement' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Stop/ })).not.toBeInTheDocument();
  });

  it('stops an announcement after confirmation', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signageoverride], { announcements: [announcementFixture({ version: 7 })] });
    let body: unknown;
    server.use(http.delete('*/api/v1/signage/announcements/:id', async ({ request }) => { body = await request.json(); return new HttpResponse(null, { status: 204 }); }));
    renderRoute(<App />, '/signage/announcements');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Stop' }));
    await user.click(await screen.findByRole('button', { name: 'Stop announcement' }));
    await waitFor(() => expect(body).toEqual({ expectedVersion: 7 }));
  });

  it('validates required fields and submits the typed values', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signageoverride]);
    let body: unknown;
    server.use(http.post('*/api/v1/signage/announcements', async ({ request }) => { body = await request.json(); return HttpResponse.json(announcementFixture(), { status: 201 }); }));
    renderRoute(<App />, '/signage/announcements');
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'New announcement' }))[0]);
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Start now' }));
    expect(await within(dialog).findByText('This field is required')).toBeInTheDocument();
    expect(body).toBeUndefined();
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'Holiday');
    expect(within(dialog).getByText('Closed today – Holiday')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('radio', { name: 'After a duration' }));
    await user.click(within(dialog).getByRole('button', { name: 'Start now' }));
    await waitFor(() => expect(body).toMatchObject({ templateId: ids.template, values: { reason: 'Holiday' }, allDisplays: true, displayIds: [], endsAt: expect.any(String) }));
    expect(body).not.toHaveProperty('startsAt');
  });

  it('maps a backend validation message to its field', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signageoverride]);
    server.use(http.post('*/api/v1/signage/announcements', () => HttpResponse.json({ code: 'validation_failed', message: 'Reason is not an allowed choice' }, { status: 422 })));
    renderRoute(<App />, '/signage/announcements');
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'New announcement' }))[0]);
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'Holiday');
    await user.click(within(dialog).getByRole('button', { name: 'Start now' }));
    expect(await within(dialog).findByText('Reason is not an allowed choice')).toBeInTheDocument();
  });

  it('requires a display when "Selected displays" is chosen', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signageoverride], { displays: [displayFixture()] });
    renderRoute(<App />, '/signage/announcements');
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: 'New announcement' }))[0]);
    const dialog = await screen.findByRole('dialog');
    await user.selectOptions(within(dialog).getByLabelText('Reason'), 'Holiday');
    await user.click(within(dialog).getByRole('radio', { name: 'Selected displays' }));
    await user.click(within(dialog).getByRole('button', { name: 'Start now' }));
    expect(await within(dialog).findByText('Choose at least one display')).toBeInTheDocument();
  });

  it('explains that listing needs signage.read', async () => {
    mockSignage([PermissionId.signageoverride]);
    renderRoute(<App />, '/signage/announcements');
    expect(await screen.findByText('Announcements cannot be listed')).toBeInTheDocument();
  });
});
