import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, roleFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const messageId = '0192f6f8-743e-7c77-a349-cd07c3e8c001';
const crew = roleFixture({ id: '0192f6f8-743e-7c77-a349-cd07c3e8c101', name: 'Crew' });

function sentMessage() {
  return {
    id: messageId,
    title: 'Cleanup day',
    body: 'Bring gloves.',
    link: null,
    roles: [{ id: crew.id, name: 'Crew' }],
    senderName: 'Test Person',
    recipientCount: 12,
    readCount: 5,
    createdAt: '2026-10-22T10:00:00Z',
    expiresAt: '2027-01-20T10:00:00Z',
  };
}

function mockMessages(permissions: PermissionId[], items = [sentMessage()]) {
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/notifications/messages', () =>
      HttpResponse.json({ items, page: 1, pageSize: 25, total: items.length }),
    ),
    http.get('*/api/v1/roles', () => HttpResponse.json({ items: [crew], nextCursor: null })),
  );
}

describe('Messages page', () => {
  it('lists the sent messages with their roles and counts', async () => {
    mockMessages([PermissionId.notificationssend]);
    renderRoute(<App />, '/notifications/messages');
    const table = await screen.findByRole('table', { name: 'Sent messages' });
    expect(within(table).getByText('Cleanup day')).toBeInTheDocument();
    expect(within(table).getByText('Crew')).toBeInTheDocument();
    expect(within(table).getByText('12')).toBeInTheDocument();
    expect(within(table).getByText('5')).toBeInTheDocument();
  });

  it('is not available without the send permission and has no navigation entry', async () => {
    mockMessages([PermissionId.peoplereadall]);
    renderRoute(<App />, '/notifications/messages');
    await waitFor(() => expect(screen.queryByRole('table', { name: 'Sent messages' })).not.toBeInTheDocument());
    expect(screen.queryByRole('link', { name: 'Messages' })).not.toBeInTheDocument();
  });

  it('offers Messages in the navigation to people who may send', async () => {
    mockMessages([PermissionId.notificationssend]);
    renderRoute(<App />, '/notifications/messages');
    const user = userEvent.setup();
    await screen.findByRole('table', { name: 'Sent messages' });
    await user.click(screen.getByRole('button', { name: 'Directory' }));
    expect(screen.getByRole('link', { name: 'Messages' })).toHaveAttribute('href', '/notifications/messages');
  });

  it('validates the form and sends the trimmed message to the chosen roles', async () => {
    mockMessages([PermissionId.notificationssend, PermissionId.rolesread]);
    let body: unknown;
    server.use(
      http.post('*/api/v1/notifications/messages', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(sentMessage(), { status: 201 });
      }),
    );
    renderRoute(<App />, '/notifications/messages');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New message' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Send message' }));
    expect(await within(dialog).findByText('Enter a title.')).toBeInTheDocument();
    expect(within(dialog).getByText('Enter the text of the message.')).toBeInTheDocument();
    expect(within(dialog).getByText('Choose at least one role.')).toBeInTheDocument();
    expect(body).toBeUndefined();

    await user.type(within(dialog).getByLabelText('Title'), '  Cleanup day ');
    await user.type(within(dialog).getByLabelText('Text'), 'Bring gloves.');
    expect(within(dialog).getByText('A page in the app (/open-days) or a web address (https://…)')).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Link/), 'http://insecure.example');
    await user.click(within(dialog).getByRole('button', { name: 'Send message' }));
    expect(await within(dialog).findByText('Web addresses must start with https://.')).toBeInTheDocument();
    await user.clear(within(dialog).getByLabelText(/Link/));
    await user.type(within(dialog).getByLabelText(/Link/), '/open-days');
    const picker = within(dialog).getByRole('combobox', { name: /Send to roles/ });
    await waitFor(() => expect(picker).toBeEnabled());
    await user.click(picker);
    await user.click((await screen.findAllByLabelText('Crew'))[0]);
    await user.click(within(dialog).getByRole('button', { name: 'Send message' }));
    await waitFor(() =>
      expect(body).toEqual({ title: 'Cleanup day', body: 'Bring gloves.', link: '/open-days', roleIds: [crew.id] }),
    );
  });

  it('explains that choosing roles needs the permission to view roles', async () => {
    mockMessages([PermissionId.notificationssend]);
    renderRoute(<App />, '/notifications/messages');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New message' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Roles cannot be listed')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Send message' })).toBeDisabled();
  });

  it('shows the server answer when nobody would receive the message', async () => {
    mockMessages([PermissionId.notificationssend, PermissionId.rolesread]);
    server.use(
      http.post('*/api/v1/notifications/messages', () =>
        HttpResponse.json({ code: 'no_recipients', message: 'Nobody.' }, { status: 422 }),
      ),
    );
    renderRoute(<App />, '/notifications/messages');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New message' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Hello');
    await user.type(within(dialog).getByLabelText('Text'), 'Text');
    const picker = within(dialog).getByRole('combobox', { name: /Send to roles/ });
    await waitFor(() => expect(picker).toBeEnabled());
    await user.click(picker);
    await user.click((await screen.findAllByLabelText('Crew'))[0]);
    await user.click(within(dialog).getByRole('button', { name: 'Send message' }));
    expect(
      await within(dialog).findByText('Nobody with an active account holds the chosen roles.'),
    ).toBeInTheDocument();
  });

  it('accepts a web address and a scheme-less host as the link', async () => {
    mockMessages([PermissionId.notificationssend, PermissionId.rolesread]);
    let body: { link?: string } | undefined;
    server.use(
      http.post('*/api/v1/notifications/messages', async ({ request }) => {
        body = (await request.json()) as { link?: string };
        return HttpResponse.json(sentMessage(), { status: 201 });
      }),
    );
    renderRoute(<App />, '/notifications/messages');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'New message' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText('Title'), 'Hello');
    await user.type(within(dialog).getByLabelText('Text'), 'Text');
    await user.type(within(dialog).getByLabelText(/Link/), 'www.example.org/x');
    const picker = within(dialog).getByRole('combobox', { name: /Send to roles/ });
    await waitFor(() => expect(picker).toBeEnabled());
    await user.click(picker);
    await user.click((await screen.findAllByLabelText('Crew'))[0]);
    await user.click(within(dialog).getByRole('button', { name: 'Send message' }));
    await waitFor(() => expect(body?.link).toBe('www.example.org/x'));
  });

  it('edits title, text and link of a sent message and reloads the list', async () => {
    mockMessages([PermissionId.notificationssend]);
    let body: unknown;
    let putId: string | undefined;
    let listCalls = 0;
    server.use(
      http.get('*/api/v1/notifications/messages', () => {
        listCalls += 1;
        return HttpResponse.json({ items: [sentMessage()], page: 1, pageSize: 25, total: 1 });
      }),
      http.put('*/api/v1/notifications/messages/:id', async ({ request, params }) => {
        putId = String(params.id);
        body = await request.json();
        return HttpResponse.json(sentMessage());
      }),
    );
    renderRoute(<App />, '/notifications/messages');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Cleanup day' }));
    await user.click(await screen.findByText('Edit'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('combobox', { name: /Send to roles/ })).not.toBeInTheDocument();
    const title = within(dialog).getByLabelText('Title');
    expect(title).toHaveValue('Cleanup day');
    await user.clear(title);
    await user.type(title, 'Cleanup day moved');
    await user.type(within(dialog).getByLabelText(/Link/), '/open-days');
    const before = listCalls;
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(body).toEqual({ title: 'Cleanup day moved', body: 'Bring gloves.', link: '/open-days' }),
    );
    expect(putId).toBe(messageId);
    await waitFor(() => expect(listCalls).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('retracts a sent message after confirmation and reloads the list', async () => {
    mockMessages([PermissionId.notificationssend]);
    let deletedId: string | undefined;
    let listCalls = 0;
    server.use(
      http.get('*/api/v1/notifications/messages', () => {
        listCalls += 1;
        return HttpResponse.json({ items: [sentMessage()], page: 1, pageSize: 25, total: 1 });
      }),
      http.delete('*/api/v1/notifications/messages/:id', ({ params }) => {
        deletedId = String(params.id);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    renderRoute(<App />, '/notifications/messages');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Actions for Cleanup day' }));
    await user.click(await screen.findByText('Retract'));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Retract this message?')).toBeInTheDocument();
    expect(
      within(dialog).getByText('It disappears for everyone, including people who already read it.'),
    ).toBeInTheDocument();
    expect(deletedId).toBeUndefined();
    const before = listCalls;
    await user.click(within(dialog).getByRole('button', { name: 'Retract message' }));
    await waitFor(() => expect(deletedId).toBe(messageId));
    await waitFor(() => expect(listCalls).toBeGreaterThan(before));
  });
});
