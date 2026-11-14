import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId, type SignageNoticeSelection } from '../../api/generated/models';
import { App } from '../../app/App';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { displayFixture, groupFixture, ids, mockSignage } from './testFixtures';

const ruleA = '0192f6f8-743e-7c77-a349-cd07c3e8d001';
const ruleB = '0192f6f8-743e-7c77-a349-cd07c3e8d002';
const ruleC = '0192f6f8-743e-7c77-a349-cd07c3e8d003';
const noticeRules = [
  { id: ruleA, name: 'Printer error', enabled: true, hasSignageAction: true },
  { id: ruleB, name: 'Low stock', enabled: false, hasSignageAction: true },
  { id: ruleC, name: 'Old tag rule', enabled: true, hasSignageAction: false },
];
const displayRoute = `/signage/displays/${ids.display}`;

describe('Notices tab', () => {
  it('lists the rules and saves the chosen ones for a display', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], {
      displays: [displayFixture()],
      noticeRules,
    });
    let body: SignageNoticeSelection | undefined;
    server.use(
      http.put('*/api/v1/signage/displays/:id/notices', async ({ request }) => {
        body = (await request.json()) as SignageNoticeSelection;
        return HttpResponse.json(body);
      }),
    );
    renderRoute(<App />, displayRoute);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Notices' }));
    expect(await screen.findByText('Rule is off')).toBeInTheDocument();
    expect(screen.getByText('No signage action any more')).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.click(screen.getByRole('checkbox', { name: 'Printer error' }));
    await user.click(save);
    await waitFor(() => expect(body).toEqual({ allRules: false, ruleIds: [ruleA] }));
  });

  it('is read-only without signage.manage', async () => {
    mockSignage([PermissionId.signageread], {
      displays: [displayFixture()],
      noticeRules,
      notices: { [ids.display]: { allRules: false, ruleIds: [ruleA] } },
    });
    renderRoute(<App />, displayRoute);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Notices' }));
    const box = await screen.findByRole('checkbox', { name: 'Printer error' });
    expect(box).toBeChecked();
    expect(box).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('shows what a display gets from its group', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], {
      displays: [displayFixture({ groupId: ids.group, defaultScenes: [] })],
      groups: [groupFixture({ displayIds: [ids.display] })],
      noticeRules,
      notices: { [ids.group]: { allRules: false, ruleIds: [ruleB] } },
    });
    renderRoute(<App />, displayRoute);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Notices' }));
    expect(await screen.findByText('From its group')).toBeInTheDocument();
    expect(await screen.findByText('Low stock', { selector: 'p' })).toBeInTheDocument();
  });

  it('saves the choice of a group', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], {
      groups: [groupFixture()],
      noticeRules,
    });
    let body: SignageNoticeSelection | undefined;
    server.use(
      http.put('*/api/v1/signage/groups/:id/notices', async ({ request }) => {
        body = (await request.json()) as SignageNoticeSelection;
        return HttpResponse.json(body);
      }),
    );
    renderRoute(<App />, `/signage/groups/${ids.group}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Notices' }));
    await user.click(await screen.findByRole('switch', { name: /All signage notices/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(body).toEqual({ allRules: true, ruleIds: [] }));
  });

  it('points to the notification center when no rule has a signage action', async () => {
    mockSignage([PermissionId.signageread, PermissionId.signagemanage], { displays: [displayFixture()] });
    renderRoute(<App />, displayRoute);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Notices' }));
    expect(await screen.findByText('No rule shows notices on signage')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Notification center' })).toBeInTheDocument();
  });
});
