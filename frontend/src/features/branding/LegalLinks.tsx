import { Link as CarbonLink } from '@carbon/react';
import { Link, useLocation } from 'react-router-dom';
import { useBranding } from './branding';

/** Router state of a legal page opened from a link: where its back button returns to. */
export type LegalReturnState = { returnTo?: string };

function LegalLink({ href, children }: { href: string; children: string }) {
  const location = useLocation();
  const external = /^https?:\/\//i.test(href);
  const state: LegalReturnState = { returnTo: location.pathname + location.search };
  return external ? (
    <CarbonLink href={href}>{children}</CarbonLink>
  ) : (
    <CarbonLink as={Link} to={href} state={state}>
      {children}
    </CarbonLink>
  );
}

export function LegalLinks({ className = '' }: { className?: string }) {
  const branding = useBranding();
  return (
    <nav className={['legal-links', className].filter(Boolean).join(' ')} aria-label="Legal information">
      <LegalLink href={branding.legal.imprint.href}>Imprint</LegalLink>
      <LegalLink href={branding.legal.privacy.href}>Privacy policy</LegalLink>
    </nav>
  );
}
