import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionId, type ConfigurationImportReport } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

const configurationFile = JSON.stringify({
  format: 'makerspace-core-config',
  version: 1,
  appVersion: 'v0.8.3',
  exportedAt: '2026-10-21T08:00:00Z',
  sections: { roles: [], deviceTypes: [], mail: {} },
});

const report = (patch: Partial<ConfigurationImportReport> = {}): ConfigurationImportReport => ({
  mode: 'overwrite',
  fingerprint: 'a'.repeat(64),
  applied: false,
  appVersion: 'v0.8.3',
  exportedAt: '2026-10-21T08:00:00Z',
  warnings: [],
  sections: [
    {
      section: 'roles',
      counts: { create: 1, update: 0, delete: 1, deactivate: 0, keep: 1, skip: 0, conflict: 0 },
      items: [
        { name: 'Supervisor', action: 'create' },
        { name: 'Temporary', action: 'delete' },
        {
          name: 'Assigned',
          action: 'keep',
          reason: 'People, visitor enrollment or staffing requirements use this role.',
        },
      ],
    },
  ],
  ...patch,
});

function setup(permissions: PermissionId[]) {
  server.use(http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture(permissions))));
}

const importer = [
  PermissionId.configurationimport,
  PermissionId.configurationexport,
  PermissionId.rolesread,
  PermissionId.rolesmanage,
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Configuration export and import', () => {
  it('is offered in Settings only with a transfer permission', async () => {
    setup([PermissionId.rolesread]);
    renderRoute(<App />, '/settings');
    expect(await screen.findByRole('heading', { name: 'Roles & Permissions' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Export & import' })).not.toBeInTheDocument();
  });

  it('exports only the sections the account may read', async () => {
    setup([PermissionId.configurationexport, PermissionId.rolesread, PermissionId.mailmanage]);
    const requested: string[] = [];
    server.use(
      http.get('*/api/v1/configuration-transfer/export', ({ request }) => {
        requested.push(...new URL(request.url).searchParams.getAll('sections'));
        return new HttpResponse(configurationFile, {
          headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment' },
        });
      }),
    );
    const createObjectURL = vi.fn(() => 'blob:configuration');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const user = userEvent.setup();
    renderRoute(<App />, '/settings');
    await user.click(await screen.findByRole('link', { name: /Export & import/ }));
    expect(await screen.findByRole('checkbox', { name: /Roles & permissions/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Email delivery/ })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: /Pricing/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Import' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Email delivery/ }));
    await user.click(screen.getByRole('button', { name: 'Download file' }));
    await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
    expect(requested).toEqual(['roles']);
  });

  it('previews an overwrite and applies it after confirming the deletions', async () => {
    setup(importer);
    let previewURL: URL | undefined;
    let applyURL: URL | undefined;
    server.use(
      http.post('*/api/v1/configuration-transfer/import/preview', ({ request }) => {
        previewURL = new URL(request.url);
        return HttpResponse.json(report());
      }),
      http.post('*/api/v1/configuration-transfer/import/apply', ({ request }) => {
        applyURL = new URL(request.url);
        return HttpResponse.json(report({ applied: true }));
      }),
    );
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/configuration-transfer');
    const input = await screen.findByLabelText('Choose file', { selector: 'input' });
    await user.upload(input, new File([configurationFile], 'config.json', { type: 'application/json' }));
    // Only sections in the file that the account may import are offered.
    const choices = within(await screen.findByRole('group', { name: 'Sections to import' }));
    expect(choices.getByRole('checkbox', { name: /Roles & permissions/ })).toBeChecked();
    expect(choices.queryByRole('checkbox', { name: /Device types/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Not available to your account: Device types, Email delivery/)).toBeInTheDocument();
    await user.click(screen.getByRole('radio', { name: /Overwrite/ }));
    await user.click(screen.getByRole('button', { name: 'Preview import' }));
    const table = await screen.findByRole('table', { name: 'Roles & permissions changes' });
    expect(within(table).getByRole('row', { name: /Temporary Delete/ })).toBeInTheDocument();
    expect(previewURL?.searchParams.get('mode')).toBe('overwrite');
    expect(previewURL?.searchParams.getAll('sections')).toEqual(['roles']);

    await user.click(screen.getByRole('button', { name: 'Apply import' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/Deleted: 1. Deactivated: 0./)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Overwrite' }));
    expect(await screen.findByText('Import applied')).toBeInTheDocument();
    expect(applyURL?.searchParams.get('fingerprint')).toBe('a'.repeat(64));
  });

  it('does not allow applying an import with conflicts', async () => {
    setup(importer);
    const conflicting = report({
      sections: [
        {
          section: 'roles',
          counts: { create: 0, update: 0, delete: 0, deactivate: 0, keep: 0, skip: 0, conflict: 1 },
          items: [{ name: 'Supervisor', action: 'conflict', code: 'permission_denied', reason: 'Permission denied' }],
        },
      ],
    });
    server.use(http.post('*/api/v1/configuration-transfer/import/preview', () => HttpResponse.json(conflicting)));
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/configuration-transfer');
    await user.upload(
      await screen.findByLabelText('Choose file', { selector: 'input' }),
      new File([configurationFile], 'config.json', { type: 'application/json' }),
    );
    await user.click(await screen.findByRole('button', { name: 'Preview import' }));
    expect(await screen.findByText('The import has conflicts')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply import' })).toBeDisabled();
  });

  it('rejects files that are not configuration files', async () => {
    setup(importer);
    const user = userEvent.setup();
    renderRoute(<App />, '/settings/configuration-transfer');
    await user.upload(
      await screen.findByLabelText('Choose file', { selector: 'input' }),
      new File(['{"format":"other"}'], 'other.json', { type: 'application/json' }),
    );
    expect(await screen.findByText('The file is not a Makerspace Core configuration file.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Preview import' })).not.toBeInTheDocument();
  });
});
