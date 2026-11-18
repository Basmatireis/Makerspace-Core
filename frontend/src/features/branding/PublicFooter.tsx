import type { ReactNode } from 'react';
import { LegalLinks } from './LegalLinks';

/**
 * Pages opened from outside the application (survey, print, public event and similar links from mails or posters)
 * have no side navigation with the legal links, so they end with this footer. Pages inside the application shell do not
 * use it.
 */
export function WithPublicFooter({ children }: { children: ReactNode }) {
  return (
    <div className="public-footer-layout">
      <div className="public-footer-layout__page">{children}</div>
      <footer className="public-footer">
        <LegalLinks />
      </footer>
    </div>
  );
}
