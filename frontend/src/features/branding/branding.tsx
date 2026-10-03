/* eslint-disable react-refresh/only-export-components -- provider and hooks form one public module */
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import type { BrandingConfiguration, PublicConfiguration } from '../../api/generated/models';
import { getPublicConfiguration } from '../../api/generated/branding/branding';

export const defaultPublicConfiguration: PublicConfiguration = {
  identity: { legalOrganizationName: 'HTU Graz', displayName: 'Makerspace', applicationName: 'HTU Graz Makerspace', tagline: null },
  colors: { primary: '#57569f', secondary: '#ffbf3d', accent: '#e76f12', background: '#111621' },
  assets: {
    logoUrl: '/brand/htumkr-symbol.png', compactLogoUrl: '/brand/htumkr-symbol.png', faviconUrl: '/brand/htumkr-symbol.png',
    applicationBackgroundUrl: '/brand/blueprint-workshop.jpg', authenticationBackgroundUrl: '/brand/blueprint-details.jpg',
  },
  legal: { imprint: { mode: 'internal', href: '/legal/imprint' }, privacy: { mode: 'internal', href: '/legal/privacy' } },
  version: 1,
};

export const publicConfigurationKey = ['branding', 'public'] as const;

export function publicConfigurationOptions() {
  return queryOptions({
    queryKey: publicConfigurationKey,
    queryFn: ({ signal }) => getPublicConfiguration({ signal }),
    initialData: defaultPublicConfiguration,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
}

const BrandingContext = createContext<PublicConfiguration>(defaultPublicConfiguration);

function imageValue(url: string | null): string {
  return url ? `url(${JSON.stringify(url)})` : 'none';
}

function mixedColor(color: string, percentage: number, target: 'black' | 'white'): string {
  return `color-mix(in srgb, ${color} ${percentage}%, ${target})`;
}

function applyDocumentBranding(configuration: PublicConfiguration) {
  const root = document.documentElement;
  const primary = configuration.colors.primary;
  const primaryHover = mixedColor(primary, 84, 'black');
  const primaryActive = mixedColor(primary, 68, 'black');

  root.style.setProperty('--app-brand-primary', primary);
  root.style.setProperty('--app-brand-secondary', configuration.colors.secondary);
  root.style.setProperty('--app-brand-accent', configuration.colors.accent);
  root.style.setProperty('--app-brand-background', configuration.colors.background);
  root.style.setProperty('--app-background-image', imageValue(configuration.assets.applicationBackgroundUrl));
  root.style.setProperty('--app-auth-background-image', imageValue(configuration.assets.authenticationBackgroundUrl));

  // Carbon remains the component system; its interactive theme tokens are
  // bridged to the installation's configured primary brand color at runtime.
  root.style.setProperty('--cds-background-brand', primary);
  root.style.setProperty('--cds-border-interactive', primary);
  root.style.setProperty('--cds-button-primary', primary);
  root.style.setProperty('--cds-button-primary-hover', primaryHover);
  root.style.setProperty('--cds-button-primary-active', primaryActive);
  root.style.setProperty('--cds-button-tertiary', primary);
  root.style.setProperty('--cds-button-tertiary-hover', primaryHover);
  root.style.setProperty('--cds-button-tertiary-active', primaryActive);
  root.style.setProperty('--cds-focus', primary);
  root.style.setProperty('--cds-icon-interactive', primary);
  root.style.setProperty('--cds-link-primary', primary);
  root.style.setProperty('--cds-link-primary-hover', primaryActive);
  root.style.setProperty('--cds-link-secondary', primaryActive);
  root.style.setProperty('--cds-highlight', mixedColor(primary, 16, 'white'));
  document.title = configuration.identity.applicationName;

  let favicon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]');
  if (configuration.assets.faviconUrl) {
    if (!favicon) {
      favicon = document.createElement('link');
      favicon.rel = 'icon';
      document.head.append(favicon);
    }
    favicon.href = configuration.assets.faviconUrl;
  } else {
    favicon?.remove();
  }
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute('content', configuration.colors.background);
}

export function BrandingProvider({ children }: { children: ReactNode }) {
  const configuration = useQuery(publicConfigurationOptions());
  const value = configuration.data ?? defaultPublicConfiguration;
  useEffect(() => applyDocumentBranding(value), [value]);
  return <BrandingContext.Provider value={value}>{children}</BrandingContext.Provider>;
}

export function useBranding(): PublicConfiguration {
  return useContext(BrandingContext);
}

export function usePageTitle(title: string) {
  const branding = useBranding();
  useEffect(() => {
    document.title = `${title} · ${branding.identity.applicationName}`;
    return () => { document.title = branding.identity.applicationName; };
  }, [branding.identity.applicationName, title]);
}

export function publicConfigurationFromAdmin(configuration: BrandingConfiguration): PublicConfiguration {
  const link = (kind: 'imprint' | 'privacy') => {
    const legal = configuration[kind];
    return { mode: legal.mode, href: legal.mode === 'external' ? legal.externalUrl : `/legal/${kind}` };
  };
  return {
    identity: configuration.identity,
    colors: configuration.colors,
    assets: {
      logoUrl: configuration.assets.logo.url,
      compactLogoUrl: configuration.assets.compactLogo.url,
      faviconUrl: configuration.assets.favicon.url,
      applicationBackgroundUrl: configuration.assets.applicationBackground.url,
      authenticationBackgroundUrl: configuration.assets.authenticationBackground.url,
    },
    legal: { imprint: link('imprint'), privacy: link('privacy') },
    version: configuration.version,
  };
}
