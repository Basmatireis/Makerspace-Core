export function defaultPublicBrandingConfiguration() {
  return {
    identity: {
      legalOrganizationName: 'HTU Graz',
      displayName: 'Makerspace',
      applicationName: 'HTU Graz Makerspace',
      tagline: null,
    },
    colors: {
      primary: '#57569f',
      secondary: '#ffbf3d',
      accent: '#e76f12',
      background: '#111621',
    },
    assets: {
      logoUrl: '/brand/htumkr-symbol.png',
      compactLogoUrl: '/brand/htumkr-symbol.png',
      faviconUrl: '/brand/htumkr-symbol.png',
      applicationBackgroundUrl: '/brand/blueprint-workshop.jpg',
      authenticationBackgroundUrl: '/brand/blueprint-details.jpg',
    },
    legal: {
      imprint: { mode: 'internal', href: '/legal/imprint' },
      privacy: { mode: 'internal', href: '/legal/privacy' },
    },
    version: 1,
  };
}
