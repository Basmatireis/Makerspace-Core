import { Link as CarbonLink } from '@carbon/react';
import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { hasEmbeddedDesktopBridge } from '../kiosk/device-bridge';
import { useBranding } from './branding';
import type { LegalDocumentKind } from './LegalDocumentModal';

const LegalDocumentModal = lazy(() => import('./LegalDocumentModal'));

/** Router state of a legal page opened from a link: where its back button returns to. */
export type LegalReturnState = { returnTo?: string };

/** Pages that run on the kiosk, where a legal document must open on top of the page instead of leaving it. */
const KIOSK_PATHS = ['/kiosk', '/visitor-enrollment'];

function useOpensEmbedded() {
  const { pathname } = useLocation();
  return hasEmbeddedDesktopBridge() || KIOSK_PATHS.includes(pathname);
}

/** A link to the imprint or the privacy policy: the legal page, the external site, or on a kiosk a dialog. */
export function LegalDocumentLink({
  kind,
  children,
  inline = false,
  size,
}: {
  kind: LegalDocumentKind;
  children: ReactNode;
  inline?: boolean;
  size?: 'sm' | 'md' | 'lg';
}) {
  const branding = useBranding();
  const location = useLocation();
  const embedded = useOpensEmbedded();
  const [open, setOpen] = useState(false);
  const href = branding.legal[kind].href;

  if (embedded) {
    return (
      <>
        <CarbonLink
          href={href}
          inline={inline}
          size={size}
          onClick={(event) => {
            event.preventDefault();
            setOpen(true);
          }}
        >
          {children}
        </CarbonLink>
        {open && (
          <Suspense fallback={null}>
            <LegalDocumentModal kind={kind} onClose={() => setOpen(false)} />
          </Suspense>
        )}
      </>
    );
  }
  if (branding.legal[kind].mode === 'external') {
    return (
      <CarbonLink href={href} inline={inline} size={size}>
        {children}
      </CarbonLink>
    );
  }
  const state: LegalReturnState = { returnTo: location.pathname + location.search };
  return (
    <CarbonLink as={Link} to={href} state={state} inline={inline} size={size}>
      {children}
    </CarbonLink>
  );
}

/** The imprint and privacy policy links; `children` adds further links to the same group, `label` names the landmark. */
export function LegalLinks({
  className = '',
  label = 'Legal information',
  children,
}: {
  className?: string;
  label?: string;
  children?: ReactNode;
}) {
  return (
    <nav className={['legal-links', className].filter(Boolean).join(' ')} aria-label={label}>
      <LegalDocumentLink kind="imprint">Imprint</LegalDocumentLink>
      <LegalDocumentLink kind="privacy">Privacy policy</LegalDocumentLink>
      {children}
    </nav>
  );
}
