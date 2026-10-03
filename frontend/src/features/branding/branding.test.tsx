import { http, HttpResponse } from 'msw';
import { screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { server } from '../../test/server';
import { renderRoute } from '../../test/render';
import type { PublicConfiguration } from '../../api/generated/models';
import { BrandingProvider } from './branding';
import { LegalPage } from './LegalPage';

const configured: PublicConfiguration = {
  identity: { legalOrganizationName: 'Example Association', displayName: 'Open Workshop', applicationName: 'Workshop Portal', tagline: 'Make things together' },
  colors: { primary: '#123456', secondary: '#abcdef', accent: '#fedcba', background: '#101820' },
  assets: { logoUrl: '/custom/logo.png', compactLogoUrl: null, faviconUrl: '/custom/favicon.png', applicationBackgroundUrl: null, authenticationBackgroundUrl: '/custom/auth.jpg' },
  legal: { imprint: { mode: 'internal', href: '/legal/imprint' }, privacy: { mode: 'external', href: 'https://example.test/privacy' } },
  version: 7,
};

describe('branding provider and public legal pages', () => {
  it('applies fetched colors, title, favicon, and nullable assets', async () => {
    document.head.querySelectorAll('link[rel~="icon"]').forEach((element) => element.remove());
    const theme = document.createElement('meta');
    theme.name = 'theme-color';
    document.head.append(theme);
    server.use(http.get('*/api/v1/public/config', () => HttpResponse.json(configured)));

    renderRoute(<BrandingProvider><p>content</p></BrandingProvider>);

    await waitFor(() => expect(document.title).toBe('Workshop Portal'));
    expect(document.documentElement.style.getPropertyValue('--app-brand-primary')).toBe('#123456');
    expect(document.documentElement.style.getPropertyValue('--cds-button-primary')).toBe('#123456');
    expect(document.documentElement.style.getPropertyValue('--cds-button-primary-hover')).toContain('#123456');
    expect(document.documentElement.style.getPropertyValue('--cds-link-primary')).toBe('#123456');
    expect(document.documentElement.style.getPropertyValue('--cds-focus')).toBe('#123456');
    expect(document.documentElement.style.getPropertyValue('--app-background-image')).toBe('none');
    expect(document.documentElement.style.getPropertyValue('--app-auth-background-image')).toContain('/custom/auth.jpg');
    expect(document.querySelector<HTMLLinkElement>('link[rel~="icon"]')?.href).toContain('/custom/favicon.png');
    expect(theme).toHaveAttribute('content', '#101820');
    theme.remove();
  });

  it('renders Markdown without executing raw HTML and keeps external links safe', async () => {
    server.use(
      http.get('*/api/v1/public/config', () => HttpResponse.json(configured)),
      http.get('*/api/v1/public/legal/imprint', () => HttpResponse.json({
        kind: 'imprint', title: 'Imprint', mode: 'internal',
        markdown: '# Publisher\n\n[External](https://example.test)\n\n<script>window.bad = true</script>', externalUrl: null,
      })),
    );

    renderRoute(<BrandingProvider><LegalPage kind="imprint" /></BrandingProvider>, '/legal/imprint');

    expect(await screen.findByRole('heading', { name: 'Publisher' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'External' })).toHaveAttribute('href', 'https://example.test');
    expect(screen.getByRole('link', { name: 'External' })).toHaveAttribute('rel', 'noopener noreferrer');
    expect(document.querySelector('.markdown-content script')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Privacy policy' })).toHaveAttribute('href', 'https://example.test/privacy');
  });
});
