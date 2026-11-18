import { Link as CarbonLink } from '@carbon/react';
import { Link } from 'react-router-dom';
import { LegalLinks } from '../features/branding/LegalLinks';

/** The footer of the application shell: legal documents and the About page. */
export function AppFooter({ navExpanded }: { navExpanded: boolean }) {
  return (
    <footer className={`app-footer${navExpanded ? ' app-footer--nav-expanded' : ''}`}>
      <LegalLinks label="Footer">
        <CarbonLink as={Link} to="/about">
          About
        </CarbonLink>
      </LegalLinks>
    </footer>
  );
}
