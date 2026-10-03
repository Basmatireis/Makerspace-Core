import { Button, Stack } from '@carbon/react';
import { ArrowLeft } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import { PageShell } from './PageShell';

export function NotFoundPage() {
  return (
    <PageShell title="Page not found" className="not-found-page">
      <Stack gap={6}>
        <p className="not-found-page__code">404</p>
        <p>The page may have moved or you may not have access to it.</p>
        <Button as={Link} to="/dashboard" renderIcon={ArrowLeft}>
          Back to dashboard
        </Button>
      </Stack>
    </PageShell>
  );
}
