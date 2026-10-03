import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BrandingConfiguration } from '../../api/generated/models';
import { server } from '../../test/server';
import { renderRoute } from '../../test/render';
import { BrandingLegalSettingsPage } from './BrandingLegalSettingsPage';

const configuration: BrandingConfiguration = {
  identity: { legalOrganizationName: 'HTU Graz', displayName: 'Makerspace', applicationName: 'HTU Graz Makerspace', tagline: null },
  colors: { primary: '#57569f', secondary: '#ffbf3d', accent: '#e76f12', background: '#111621' },
  assets: {
    logo: { slot: 'logo', mode: 'default', url: '/brand/htumkr-symbol.png', originalFilename: null, contentType: null, sizeBytes: null, updatedAt: null },
    compactLogo: { slot: 'compact_logo', mode: 'default', url: '/brand/htumkr-symbol.png', originalFilename: null, contentType: null, sizeBytes: null, updatedAt: null },
    favicon: { slot: 'favicon', mode: 'default', url: '/brand/htumkr-symbol.png', originalFilename: null, contentType: null, sizeBytes: null, updatedAt: null },
    applicationBackground: { slot: 'application_background', mode: 'default', url: '/brand/blueprint-workshop.jpg', originalFilename: null, contentType: null, sizeBytes: null, updatedAt: null },
    authenticationBackground: { slot: 'authentication_background', mode: 'default', url: '/brand/blueprint-details.jpg', originalFilename: null, contentType: null, sizeBytes: null, updatedAt: null },
  },
  imprint: { mode: 'internal', markdown: '', externalUrl: '' },
  privacy: { mode: 'internal', markdown: '', externalUrl: '' },
  version: 1,
  updatedAt: '2026-10-03T10:00:00Z',
};

describe('branding and legal settings', () => {
  it('tracks unsaved identity values, validates HEX colors, and previews drafts', async () => {
    server.use(http.get('*/api/v1/branding/configuration', () => HttpResponse.json(configuration)));
    const user = userEvent.setup();
    renderRoute(<BrandingLegalSettingsPage />, '/settings/branding-legal');

    const heading = await screen.findByRole('heading', { name: 'Branding & legal' });
    const shell = heading.closest('[data-page-shell]');
    expect(shell).toHaveAttribute('data-page-width', 'standard');
    expect(shell?.querySelector('.page-header__tabs')).toContainElement(
      screen.getByRole('tablist', { name: 'Branding configuration sections' }),
    );
    const displayName = screen.getByLabelText('Display name');
    await user.clear(displayName);
    await user.type(displayName, 'Open Workshop');
    expect(screen.getAllByText('You have unsaved changes.').length).toBeGreaterThan(0);
    expect(screen.getByText('Open Workshop')).toBeInTheDocument();

    const primary = screen.getByLabelText('Primary');
    await user.clear(primary);
    await user.type(primary, '#fff');
    await waitFor(() => expect(screen.getByText(/Use a six-digit HEX color/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Save configuration' })).toBeDisabled();
  });

  it('keeps the native color picker and HEX input synchronized', async () => {
    server.use(http.get('*/api/v1/branding/configuration', () => HttpResponse.json(configuration)));
    renderRoute(<BrandingLegalSettingsPage />, '/settings/branding-legal');

    expect(await screen.findByRole('heading', { name: 'Branding & legal' })).toBeInTheDocument();
    const picker = screen.getByLabelText('Primary color picker');
    const textInput = screen.getByLabelText('Primary');

    fireEvent.change(picker, { target: { value: '#123456' } });

    expect(textInput).toHaveValue('#123456');
    expect(picker).toHaveValue('#123456');
    expect(screen.getAllByText('You have unsaved changes.').length).toBeGreaterThan(0);
  });
});
