import { Stack, Tile } from '@carbon/react';
import { useBranding } from '../features/branding/branding';
import { PageShell } from './PageShell';

type InformationPageProps = {
  title: string;
};

export function InformationPage({ title }: InformationPageProps) {
  const branding = useBranding();
  return <PageShell title={title}><Tile><Stack gap={4}><h2>{branding.identity.applicationName}</h2><p>{branding.identity.tagline || `${branding.identity.displayName}, operated by ${branding.identity.legalOrganizationName}.`}</p></Stack></Tile></PageShell>;
}
