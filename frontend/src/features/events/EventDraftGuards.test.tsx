import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { EventStaffingPanel } from './EventStaffingPanel';
import { EventSchedulePanel } from './EventSchedulePanel';
import { TaskListEditDialog } from './EventEditDialogs';

const eventId = '0192f6f8-743e-7c77-a349-cd07c3e8a001';
const shiftId = '0192f6f8-743e-7c77-a349-cd07c3e8a002';
const requirementId = '0192f6f8-743e-7c77-a349-cd07c3e8a003';
const roleId = '0192f6f8-743e-7c77-a349-cd07c3e8a004';
const timestamp = '2026-10-04T12:00:00Z';

function mockStaffing() {
  server.use(
    http.get(`*/api/v1/events/${eventId}/shifts`, () => HttpResponse.json({ items: [{
      id: shiftId, eventId, sessionId: null, name: 'Setup', description: null,
      startsAt: '2026-11-02T14:00:00Z', endsAt: '2026-11-02T16:00:00Z', signupOpensAt: null,
      signupClosesAt: null, isPublic: true, status: 'open', linkedSessionStatus: null, version: 1,
      createdAt: timestamp, updatedAt: timestamp,
    }] })),
    http.get(`*/api/v1/events/${eventId}/shifts/${shiftId}/requirements`, () => HttpResponse.json({ items: [{
      id: requirementId, eventId, shiftId, name: 'Helper', description: null, requiredCount: 2,
      filledCount: 0, eligibilityMode: 'roles', eligibleRoleIds: [roleId], version: 1,
      createdAt: timestamp, updatedAt: timestamp,
    }] })),
    http.get(`*/api/v1/events/${eventId}/assignments`, () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/event-eligibility-roles', () => HttpResponse.json({ items: [{ id: roleId, name: 'Workshop helper' }] })),
    http.get('*/api/v1/event-people', () => HttpResponse.json({ items: [] })),
  );
}

describe('Event draft guards', () => {
  it('protects eligibility-only requirement edits on cancel', async () => {
    mockStaffing();
    const user = userEvent.setup();
    renderRoute(<EventStaffingPanel eventId={eventId} canStaff canAssign archived={false} />);
    await user.click(await screen.findByRole('button', { name: 'Actions for Helper' }));
    await user.click(await screen.findByText('Edit', { exact: true }));
    await user.click(screen.getByLabelText('Workshop helper'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Workshop helper')).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByRole('heading', { name: 'Edit requirement' })).not.toBeInTheDocument();
  });

  it('protects requirement and assignment drafts when their toolbar toggles close them', async () => {
    mockStaffing();
    const user = userEvent.setup();
    renderRoute(<EventStaffingPanel eventId={eventId} canStaff canAssign archived={false} />);
    await user.click(await screen.findByRole('button', { name: 'Add requirement' }));
    await user.type(screen.getByLabelText('Name', { exact: true }), 'Welcome desk');
    await user.click(screen.getAllByRole('button', { name: 'Add requirement' })[0]);
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Name', { exact: true })).toHaveValue('Welcome desk');
    await user.click(screen.getAllByRole('button', { name: 'Add requirement' })[0]);
    await user.click(screen.getByRole('button', { name: 'Discard changes' }));
    await user.click(screen.getByRole('button', { name: 'Assign helper' }));
    await user.type(screen.getByLabelText('First name'), 'Grace');
    await user.click(screen.getByRole('button', { name: 'Assign helper' }));
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('First name')).toHaveValue('Grace');
  });

  it('protects a shift status-only draft on Escape without stacking dialogs', async () => {
    server.use(
      http.get(`*/api/v1/events/${eventId}/sessions`, () => HttpResponse.json({ items: [] })),
      http.get(`*/api/v1/events/${eventId}/shifts`, () => HttpResponse.json({ items: [] })),
    );
    const user = userEvent.setup();
    renderRoute(<EventSchedulePanel eventId={eventId} canManage canStaff archived={false} />);
    await user.click(await screen.findByRole('button', { name: 'Add shift' }));
    await user.selectOptions(screen.getByLabelText('Status'), 'open');
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('alertdialog')).toHaveTextContent('Discard unsaved changes?');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByLabelText('Status')).toHaveValue('open');
  });

  it('keeps an edit dialog open on Escape while saving and retains input after failure', async () => {
    let finishRequest!: () => void;
    const pendingResponse = new Promise<void>((resolve) => { finishRequest = resolve; });
    server.use(http.patch(`*/api/v1/events/${eventId}/task-lists/${requirementId}`, async () => {
      await pendingResponse;
      return HttpResponse.json({ code: 'stale_write', message: 'Resource changed', requestId: 'task-list' }, { status: 409 });
    }));
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderRoute(<TaskListEditDialog eventId={eventId} list={{ id: requirementId, eventId, name: 'Preparation', description: null, sortOrder: 0, version: 1, createdAt: timestamp, updatedAt: timestamp }} onClose={onClose} onSaved={async () => undefined} />);
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText('Name'), ' draft');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeDisabled());
    await user.click(screen.getByLabelText('Name'));
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog.closest('.cds--modal')).toHaveClass('is-visible');
    await act(async () => { finishRequest(); await pendingResponse; });
    expect(await screen.findByText('This event changed in another session. Reload it before saving again.')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Preparation draft');
    await user.click(screen.getByLabelText('Name'));
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });
});
