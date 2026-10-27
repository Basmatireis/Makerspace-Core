import { http, HttpResponse } from 'msw';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';
import { settingsItems } from './settingsCatalog';
import { settingsPermissions } from '../auth/permissions';

function signInWith(...permissions: PermissionId[]) {
  server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))));
}

describe('settings catalog', () => {
  it('is covered by the settings route guard permissions', () => {
    const catalog = new Set(settingsItems.flatMap((item) => item.permissions));
    expect([...catalog].sort()).toEqual([...settingsPermissions].sort());
  });
});

describe('settings overview', () => {
  it('groups tiles under headings and hides groups without visible tiles', async () => {
    signInWith(PermissionId.rolesread, PermissionId.oidcmanage, PermissionId.mailmanage);
    renderRoute(<App />, '/settings');

    expect(await screen.findByRole('heading', { name: 'Access & identity', level: 2 })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Communication & appearance', level: 2 })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Lab operations' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Data' })).not.toBeInTheDocument();
    const access = screen.getByRole('region', { name: 'Access & identity' });
    expect(within(access).getByRole('link', { name: /Single sign-on/ })).toHaveAttribute(
      'href',
      '/settings/single-sign-on',
    );
    expect(within(access).queryByRole('link', { name: /Devices & sessions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Pricing/ })).not.toBeInTheDocument();
  });

  it.each([
    [PermissionId.scimmanage, /Single sign-on/],
    [PermissionId.session_policiesmanage, /Devices & sessions/],
    [PermissionId.managed_devicesread, /Devices & sessions/],
    [PermissionId.invoicingsettingsmanage, /Invoicing/],
    [PermissionId.configurationimport, /Export & import/],
  ])('shows the merged or newly admitted tile for %s', async (permission, name) => {
    signInWith(permission);
    renderRoute(<App />, '/settings');
    expect(await screen.findByRole('link', { name })).toBeInTheDocument();
  });

  it('filters tiles client-side', async () => {
    signInWith(
      PermissionId.rolesread,
      PermissionId.oidcmanage,
      PermissionId.mailmanage,
      PermissionId.brandingmanage,
      PermissionId.surveysread,
      PermissionId.configurationexport,
      PermissionId.invoicingsettingsmanage,
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings');
    await user.type(await screen.findByRole('searchbox', { name: 'Filter settings' }), 'smtp');
    expect(screen.getByRole('link', { name: /Email delivery/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Roles/ })).not.toBeInTheDocument();
  });
});

describe('merged settings pages', () => {
  it.each([
    ['/settings/oidc', '/settings/single-sign-on', 'tab=oidc'],
    ['/settings/scim', '/settings/single-sign-on', 'tab=scim'],
    ['/settings/session-policies', '/settings/devices-sessions', 'tab=session-policies'],
    ['/settings/managed-devices', '/settings/devices-sessions', 'tab=managed-devices'],
  ])('redirects %s to its tab', async (from, pathname, search) => {
    signInWith(
      PermissionId.oidcmanage,
      PermissionId.scimmanage,
      PermissionId.session_policiesmanage,
      PermissionId.managed_devicesread,
    );
    const { router } = renderRoute(<App />, from);
    await screen.findByRole('tablist');
    expect(router.state.location.pathname).toBe(pathname);
    expect(router.state.location.search).toBe(`?${search}`);
  });

  it('shows only the tabs the person may use', async () => {
    signInWith(PermissionId.scimmanage);
    server.use(http.get('*/api/v1/scim/connectors', () => HttpResponse.json({ items: [] })));
    renderRoute(<App />, '/settings/single-sign-on');
    const tablist = await screen.findByRole('tablist', { name: 'Single sign-on sections' });
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['SCIM provisioning']);
  });

  it('falls back to the first permitted tab for a tab that is not permitted', async () => {
    signInWith(PermissionId.managed_devicesread);
    renderRoute(<App />, '/settings/devices-sessions?tab=session-policies');
    const tablist = await screen.findByRole('tablist', { name: 'Devices and sessions sections' });
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Managed devices', 'Device types']);
  });

  it('denies the merged pages without any of their permissions', async () => {
    signInWith(PermissionId.rolesread);
    renderRoute(<App />, '/settings/single-sign-on');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });
});
