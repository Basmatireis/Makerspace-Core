import { http, HttpResponse } from 'msw';
import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { App } from '../../app/App';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { server } from '../../test/server';

vi.mock('@carbon/charts-react', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  SimpleBarChart: () => <div data-testid="bar-chart" />,
}));

describe('Machine Logbook pages', () => {
  it('does not expose the overview to an inventory-only reader', async () => {
    server.use(
      http.get('*/api/v1/auth/me', () => HttpResponse.json(currentUserFixture([PermissionId.inventoryread]))),
      http.get('*/api/v1/materials', () => HttpResponse.json({ items: [], page: 1, pageSize: 25, total: 0, totalInventoryValue: '0' })),
    );
    renderRoute(<App />, '/machine-logbook');
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Overview' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Inventory' })).toBeInTheDocument();
  });
});
