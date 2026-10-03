import { Link as CarbonLink } from '@carbon/react';
import { Link } from 'react-router-dom';
import { useBranding } from './branding';

function LegalLink({ href, children }: { href: string; children: string }) {
  const external = /^https?:\/\//i.test(href);
  return external ? <CarbonLink href={href}>{children}</CarbonLink> : <CarbonLink as={Link} to={href}>{children}</CarbonLink>;
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
