import { useEffect } from 'react';
import { Button, Stack } from '@carbon/react';
import { ArrowLeft, Renew } from '@carbon/icons-react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { shouldReloadForChunkError, isChunkLoadError } from './chunkLoadRecovery';
import { FullPageLoading } from './PageState';

export function RouteErrorPage() {
  const error = useRouteError();
  const chunkLoadError = isChunkLoadError(error);
  const reloading = shouldReloadForChunkError(error);

  useEffect(() => {
    if (reloading) {
      window.location.reload();
    }
  }, [reloading]);

  if (reloading) {
    return <FullPageLoading label="Loading the latest version" />;
  }

  const title = chunkLoadError ? 'A new version is available' : 'Something went wrong';
  const message = chunkLoadError
    ? 'The application was updated while this tab was open. Reload the page to continue with the latest version.'
    : isRouteErrorResponse(error) && error.status === 404
      ? 'The page could not be found.'
      : 'An unexpected error interrupted this page. Reload it, or go back to the dashboard.';

  return (
    <main className="route-error-page">
      <Stack gap={6}>
        <h1 className="route-error-page__title">{title}</h1>
        <p>{message}</p>
        <div className="route-error-page__actions">
          <Button renderIcon={Renew} onClick={() => window.location.reload()}>
            Reload page
          </Button>
          <Button kind="ghost" renderIcon={ArrowLeft} href="/dashboard">
            Back to dashboard
          </Button>
        </div>
      </Stack>
    </main>
  );
}
