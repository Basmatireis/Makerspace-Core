import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

describe('Visitor sign-up tab of Devices & sessions', () => {
  it('opens from the old visitor enrollment route and shows the settings', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.visitor_enrollmentmanage])),
      ),
      http.get('*/api/v1/visitor-enrollment/configuration', () =>
        HttpResponse.json({ enabled: true, deviceTypeIds: [], allowedMethods: ['pin'], version: 1 }),
      ),
      http.get('*/api/v1/managed-device-types', () => HttpResponse.json({ items: [] })),
    );
    renderRoute(<App />, '/settings/visitor-enrollment');
    expect(await screen.findByRole('tab', { name: 'Visitor sign-up', selected: true })).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: 'Enable visitor-kiosk enrollment' })).toBeChecked();
    expect(screen.queryByRole('tab', { name: 'Managed devices' })).not.toBeInTheDocument();
  });
});
