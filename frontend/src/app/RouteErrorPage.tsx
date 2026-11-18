import { lazy, Suspense, useEffect, useState } from 'react';
import { Button, InlineNotification, Stack } from '@carbon/react';
import { ArrowLeft, Renew } from '@carbon/icons-react';
import { isRouteErrorResponse, useRouteError } from 'react-router-dom';
import { shouldReloadForChunkError, isChunkLoadError } from './chunkLoadRecovery';
import { componentStackOf, errorHint, summarizeError } from './errorSummary';
import { FullPageLoading } from './PageState';

function DetailsUnavailable() {
  return <p className="error-report__help">The technical details could not be loaded.</p>;
}

// The details load only after a crash. When even that fails (offline, or a deploy removed the chunk), the error code,
// reference and hint above still tell what happened.
const ErrorReportDetails = lazy(() => import('./ErrorReportDetails').catch(() => ({ default: DetailsUnavailable })));

export function RouteErrorPage() {
  const error = useRouteError();
  const chunkLoadError = isChunkLoadError(error);
  const reloading = shouldReloadForChunkError(error);
  const [summary] = useState(() => summarizeError(error));
  const [componentStack, setComponentStack] = useState<string | undefined>(undefined);

  // React hands over the component stack after this page rendered (see onCaughtError in main.tsx).
  useEffect(() => setComponentStack(componentStackOf(error)), [error]);

  useEffect(() => {
    if (reloading) {
      window.location.reload();
    }
  }, [reloading]);

  if (reloading) {
    return <FullPageLoading label="Loading the latest version" />;
  }

  const notFound = isRouteErrorResponse(error) && error.status === 404;
  const hint = errorHint(summary);
  const title = chunkLoadError ? 'A new version is available' : 'Something went wrong';
  const message = chunkLoadError
    ? 'The application was updated while this tab was open. Reload the page to continue with the latest version.'
    : notFound
      ? 'The page could not be found.'
      : 'An unexpected error interrupted this page. Reload it, or go back to the dashboard.';

  return (
    <main className="route-error-page">
      <Stack gap={6}>
        <h1 className="route-error-page__title">{title}</h1>
        <p>{message}</p>
        {!notFound && (
          <p className="error-report__reference">
            Error code <strong>{summary.code}</strong> · Reference <strong>{summary.reference}</strong> ·{' '}
            <time dateTime={summary.occurredAt}>{new Date(summary.occurredAt).toLocaleString()}</time>
          </p>
        )}
        {hint && summary.kind !== 'chunk_load' && (
          <InlineNotification kind="info" lowContrast hideCloseButton title="Likely cause" subtitle={hint} />
        )}
        <div className="route-error-page__actions">
          <Button renderIcon={Renew} onClick={() => window.location.reload()}>
            Reload page
          </Button>
          <Button kind="ghost" renderIcon={ArrowLeft} href="/dashboard">
            Back to dashboard
          </Button>
        </div>
        {!notFound && (
          <Suspense fallback={null}>
            <ErrorReportDetails error={error} summary={summary} componentStack={componentStack} />
          </Suspense>
        )}
      </Stack>
    </main>
  );
}
