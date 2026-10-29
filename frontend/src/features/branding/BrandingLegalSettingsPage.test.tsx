import { http, HttpResponse } from 'msw';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { BrandingConfiguration } from '../../api/generated/models';
import { server } from '../../test/server';
import { renderRoute } from '../../test/render';
import { BrandingLegalSettingsPage } from './BrandingLegalSettingsPage';

const configuration: BrandingConfiguration = {
  identity: {
    legalOrganizationName: 'HTU Graz',
    displayName: 'Makerspace',
    applicationName: 'HTU Graz Makerspace',
    tagline: null,
    funGreetings: [],
    funGreetingShare: 0,
  },
  colors: { primary: '#57569f', secondary: '#ffbf3d', accent: '#e76f12', background: '#111621' },
  assets: {
    logo: {
      slot: 'logo',
      mode: 'default',
      url: '/brand/htumkr-symbol.png',
      originalFilename: null,
      contentType: null,
      sizeBytes: null,
      updatedAt: null,
    },
    compactLogo: {
      slot: 'compact_logo',
      mode: 'default',
      url: '/brand/htumkr-symbol.png',
      originalFilename: null,
      contentType: null,
      sizeBytes: null,
      updatedAt: null,
    },
    favicon: {
      slot: 'favicon',
      mode: 'default',
      url: '/brand/htumkr-symbol.png',
      originalFilename: null,
      contentType: null,
      sizeBytes: null,
      updatedAt: null,
    },
    applicationBackground: {
      slot: 'application_background',
      mode: 'default',
      url: '/brand/blueprint-workshop.jpg',
      originalFilename: null,
      contentType: null,
      sizeBytes: null,
      updatedAt: null,
    },
    authenticationBackground: {
      slot: 'authentication_background',
      mode: 'default',
      url: '/brand/blueprint-details.jpg',
      originalFilename: null,
      contentType: null,
      sizeBytes: null,
      updatedAt: null,
    },
  },
  imprint: { mode: 'internal', markdown: '', externalUrl: '' },
  privacy: { mode: 'internal', markdown: '', externalUrl: '' },
  version: 1,
  updatedAt: '2026-10-03T10:00:00Z',
};

describe('branding and legal settings', () => {
  it('confirms permanent asset removal and distinguishes it from restoring the default', async () => {
    const customConfiguration: BrandingConfiguration = {
      ...configuration,
      assets: {
        ...configuration.assets,
        logo: {
          slot: 'logo',
          mode: 'custom',
          url: '/api/v1/branding/assets/logo',
          originalFilename: 'logo.png',
          contentType: 'image/png',
          sizeBytes: 1200,
          updatedAt: '2026-10-11T08:00:00Z',
        },
      },
    };
    let requestBody: unknown;
    server.use(
      http.get('*/api/v1/branding/configuration', () => HttpResponse.json(customConfiguration)),
      http.delete('*/api/v1/branding/assets/logo', async ({ request }) => {
        requestBody = await request.json();
        return HttpResponse.json({
          ...customConfiguration,
          version: 2,
          assets: {
            ...customConfiguration.assets,
            logo: {
              slot: 'logo',
              mode: 'none',
              url: null,
              originalFilename: null,
              contentType: null,
              sizeBytes: null,
              updatedAt: '2026-10-11T09:00:00Z',
            },
          },
        });
      }),
    );
    const user = userEvent.setup();
    renderRoute(<BrandingLegalSettingsPage />, '/settings/branding-legal');

    await user.click(await screen.findByRole('tab', { name: 'Assets' }));
    const logoCard = screen.getByRole('heading', { name: 'Logo' }).closest('.cds--tile') as HTMLElement;
    await user.click(within(logoCard).getByRole('button', { name: 'Remove' }));
    const dialog = screen.getByRole('alertdialog', { name: 'Remove logo?' });
    expect(within(dialog).getByText(/differs from restoring the bundled default/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toHaveFocus();
    expect(requestBody).toBeUndefined();

    await user.click(within(dialog).getByRole('button', { name: 'Remove asset' }));
    await waitFor(() => expect(requestBody).toEqual({ expectedVersion: 1 }));
    await waitFor(() => expect(within(logoCard).getByText('Removed')).toBeInTheDocument());
  });

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
    const picker = screen.getByLabelText('Choose primary color');
    const textInput = screen.getByLabelText('Primary');

    fireEvent.change(picker, { target: { value: '#123456' } });

    expect(textInput).toHaveValue('#123456');
    expect(picker).toHaveValue('#123456');
    expect(screen.getAllByText('You have unsaved changes.').length).toBeGreaterThan(0);
  });

  it('saves the playful greetings one per line and how often they appear', async () => {
    let body: { identity?: { funGreetings?: string[]; funGreetingShare?: number } } | undefined;
    server.use(
      http.get('*/api/v1/branding/configuration', () => HttpResponse.json(configuration)),
      http.put('*/api/v1/branding/configuration', async ({ request }) => {
        body = (await request.json()) as typeof body;
        return HttpResponse.json(configuration);
      }),
    );
    const user = userEvent.setup();
    renderRoute(<BrandingLegalSettingsPage />, '/settings/branding-legal');
    const greetings = await screen.findByLabelText('Playful greetings');
    expect(screen.getByText(/\{name\} is replaced by the person's first name/)).toBeInTheDocument();
    await user.type(greetings, '  Hello {{name}!  {Enter}{Enter}Hammer time');
    const share = screen.getByLabelText('How often');
    await user.clear(share);
    await user.type(share, '25');
    await user.click(screen.getByRole('button', { name: 'Save configuration' }));
    await waitFor(() => expect(body?.identity?.funGreetings).toEqual(['Hello {name}!', 'Hammer time']));
    expect(body?.identity?.funGreetingShare).toBe(25);
    expect(body).not.toHaveProperty('greetingsText');
  });
});
