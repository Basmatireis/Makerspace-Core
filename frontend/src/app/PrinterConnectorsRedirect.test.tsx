import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { PermissionId } from '../api/generated/models';
import { currentUserFixture } from '../test/fixtures';
import { renderRoute } from '../test/render';
import { server } from '../test/server';
import { App } from './App';

describe('printer connector settings route', () => {
  it('redirects the old printer connector settings page to Settings, Local services', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json(currentUserFixture([PermissionId.machinesread, PermissionId.printer_connectorsread])),
      ),
      http.get('*/api/v1/printer-connectors', () => HttpResponse.json({ items: [] })),
      http.get('*/api/v1/machines', () => HttpResponse.json({ items: [], page: 1, pageSize: 100, total: 0 })),
      http.get('*/api/v1/machine-logbook/machine-activity', () => HttpResponse.json({ items: [] })),
    );
    const { router } = renderRoute(<App />, '/settings/printer-connectors');

    expect(
      await screen.findByRole('tab', { name: 'Printer connectors', selected: true }, { timeout: 5000 }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings/local-services');
    expect(router.state.location.search).toBe('?tab=connectors');
  });
});
