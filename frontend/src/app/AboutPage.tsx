import type { ReactNode } from 'react';
import { Link as CarbonLink, ListItem, Stack, Tile, UnorderedList } from '@carbon/react';
import { Link } from 'react-router-dom';
import { useBranding } from '../features/branding/branding';
import type { PublicLegalLink } from '../api/generated/models';
import { Fact, FactsGrid } from './components/Facts';
import { PageShell } from './PageShell';

const repositoryUrl = 'https://github.com/Basmatireis/Makerspace-Core';

// Set by the release image build (frontend/Dockerfile); development builds have none.
const version: string | undefined = import.meta.env.VITE_APP_VERSION || undefined;

const areas: [string, string][] = [
  ['Workshop', 'Machines, print jobs and runs, filament spools and the machine logbook.'],
  ['Open days', 'Opening hours, supervisor staffing and attendance at the tablet terminal.'],
  ['People', 'Members, guests, roles, trainings and Lab Rules confirmations.'],
  ['Sales & payments', 'Orders, pricing, the cash register and invoicing.'],
  ['Signage', 'Content for the displays in the lab.'],
];

function LegalLink({ link, children }: { link: PublicLegalLink; children: ReactNode }) {
  if (link.mode === 'external') return <CarbonLink href={link.href}>{children}</CarbonLink>;
  return (
    <CarbonLink as={Link} to={link.href}>
      {children}
    </CarbonLink>
  );
}

export function AboutPage() {
  const { identity, legal } = useBranding();
  return (
    <PageShell title="About">
      <div className="detail-grid">
        <Tile>
          <Stack gap={4}>
            <h2>{identity.applicationName}</h2>
            <p>{identity.tagline || `${identity.displayName}, operated by ${identity.legalOrganizationName}.`}</p>
            <p>This application runs the day-to-day operation of the lab:</p>
            <UnorderedList>
              {areas.map(([name, description]) => (
                <ListItem key={name}>
                  <strong>{name}</strong>: {description}
                </ListItem>
              ))}
            </UnorderedList>
          </Stack>
        </Tile>
        <Tile>
          <Stack gap={5}>
            <h2>Software</h2>
            <FactsGrid>
              <Fact label="Application">Makerspace Core</Fact>
              <Fact label="Version">
                {version ? (
                  <CarbonLink href={`${repositoryUrl}/releases/tag/v${version}`}>{version}</CarbonLink>
                ) : (
                  'Development build'
                )}
              </Fact>
              <Fact label="License">
                <CarbonLink href={`${repositoryUrl}/blob/main/LICENSE`}>Apache License 2.0</CarbonLink>
              </Fact>
              <Fact label="Source code">
                <CarbonLink href={repositoryUrl}>GitHub</CarbonLink>
              </Fact>
            </FactsGrid>
            <p>
              Built with the IBM Carbon Design System and the IBM Plex typeface. See the{' '}
              <CarbonLink href="/THIRD_PARTY_NOTICES.txt" inline>
                third-party notices
              </CarbonLink>{' '}
              for their licenses.
            </p>
            <p>
              <LegalLink link={legal.imprint}>Imprint</LegalLink> ·{' '}
              <LegalLink link={legal.privacy}>Privacy policy</LegalLink>
            </p>
          </Stack>
        </Tile>
      </div>
    </PageShell>
  );
}
