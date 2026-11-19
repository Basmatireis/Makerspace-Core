import { http, HttpResponse } from 'msw';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture, fixturePersonId, otherPersonId } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { addDays, todayOn } from '../workinggroups/taskModel';

const printId = '0192f6f8-743e-7c77-a349-cd07c3e8e001';
const woodId = '0192f6f8-743e-7c77-a349-cd07c3e8e002';
const ada = { personId: fixturePersonId, displayName: 'Ada Lovelace' };
const grace = { personId: otherPersonId, displayName: 'Grace Hopper' };

function serve(permissions: PermissionId[]) {
  const summary = (id: string, name: string, isMember: boolean) => ({
    id,
    name,
    description: '',
    memberCount: 1,
    machineCount: 1,
    isMember,
    isLead: false,
  });
  server.use(
    http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))),
    http.get('*/api/v1/me/dashboard', () =>
      HttpResponse.json({ person: { firstName: 'Ada', memberSince: '2025-01-01T00:00:00Z' } }),
    ),
    http.get('*/api/v1/laborordnung/status/me', () =>
      HttpResponse.json({
        mode: 'warning',
        state: 'current',
        actionRequired: false,
        currentVersion: null,
        latestConfirmedVersion: null,
        latestConfirmedAt: null,
      }),
    ),
    http.get('*/api/v1/working-groups', () =>
      HttpResponse.json({ items: [summary(printId, 'Printing', true), summary(woodId, 'Woodworking', false)] }),
    ),
    http.get('*/api/v1/working-group-status', () =>
      HttpResponse.json({
        items: [
          {
            kind: 'machine',
            id: '0192f6f8-743e-7c77-a349-cd07c3e8e101',
            name: 'Prusa CORE One',
            group: { id: printId, name: 'Printing' },
            status: 'ok',
            daysNotOkLast90: 0,
          },
          {
            kind: 'machine',
            id: '0192f6f8-743e-7c77-a349-cd07c3e8e102',
            name: 'Table saw',
            group: { id: woodId, name: 'Woodworking' },
            status: 'out_of_order',
            note: 'Blade broken',
            changedAt: '2026-02-01T10:00:00Z',
            changedBy: grace,
            daysNotOkLast90: 12,
          },
        ],
      }),
    ),
    http.get('*/api/v1/working-group-notes', () =>
      HttpResponse.json({
        items: [
          {
            id: '0192f6f8-743e-7c77-a349-cd07c3e8b001',
            public: true,
            groupId: printId,
            groupName: 'Printing',
            text: 'Printer room closed on Monday',
            createdAt: '2026-03-01T10:00:00Z',
            author: grace,
            canDelete: false,
          },
        ],
      }),
    ),
    http.get('*/api/v1/working-group-tickets', () => HttpResponse.json({ items: [] })),
    http.get('*/api/v1/working-group-todos', () =>
      HttpResponse.json({
        items: [
          {
            id: '0192f6f8-743e-7c77-a349-cd07c3e8f002',
            groupId: printId,
            groupName: 'Printing',
            title: 'Clean the bed',
            dueOn: addDays(todayOn(), -1),
            columnId: '0192f6f8-743e-7c77-a349-cd07c3e8c001',
            done: false,
            isMine: true,
            assignee: ada,
            commentCount: 0,
            version: 1,
            createdAt: '2026-01-01T10:00:00Z',
            updatedAt: '2026-01-01T10:00:00Z',
          },
        ],
      }),
    ),
  );
}

describe('dashboard pinboard', () => {
  it('lists what is yours, then what is not ok, then notes, and expands a machine row', async () => {
    const user = userEvent.setup();
    serve([PermissionId.working_groupsread]);
    renderRoute(<App />, '/dashboard');

    const table = await screen.findByRole('table', { name: 'Pinboard' });
    const rows = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => row.textContent ?? '');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('Yours');
    expect(rows[0]).toContain('Clean the bed');
    expect(rows[1]).toContain('Table saw');
    expect(rows[1]).toContain('Out of order');
    expect(rows[2]).toContain('Printer room closed on Monday');
    expect(rows[2]).toContain('Printing');

    const toggle = within(table).getByRole('button', { name: 'Table saw' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(within(table).getByText('Status since')).toBeInTheDocument();
    expect(within(table).getByText('Changed by')).toBeInTheDocument();
    expect(within(table).getAllByText('Grace Hopper').length).toBeGreaterThan(1);
    // Not inside Woodworking and no management: no way to change the status.
    expect(within(table).queryByRole('button', { name: 'Change status' })).not.toBeInTheDocument();

    const all = screen.getByRole('heading', { name: 'All machines and places' }).closest('section');
    const names = within(all as HTMLElement)
      .getAllByRole('listitem')
      .map((item) => item.textContent ?? '');
    expect(names[0]).toContain('Table saw');
    expect(names[1]).toContain('Prusa CORE One');
  });

  it('is hidden without working_groups.read', async () => {
    serve([]);
    renderRoute(<App />, '/dashboard');
    await screen.findByRole('heading', { name: /^Good (morning|afternoon|evening)|Still up, Ada$/ });
    expect(screen.queryByRole('heading', { name: 'Pinboard' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'All machines and places' })).not.toBeInTheDocument();
  });
});
