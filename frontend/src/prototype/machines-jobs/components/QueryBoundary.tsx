import type { ReactNode } from 'react';
import { DataTableSkeleton } from '@carbon/react';
import { ErrorState } from '../../../app/PageState';

type Query = { status: 'pending' | 'error' | 'success'; retry: () => void };

/** Renders the loading and error states of a simulated query consistently. */
export function QueryBoundary({ query, loading, errorMessage = 'The data could not be loaded.', children }: {
  query: Query;
  loading?: ReactNode;
  errorMessage?: string;
  children: ReactNode;
}) {
  if (query.status === 'pending') return <>{loading ?? <DataTableSkeleton columnCount={5} rowCount={6} showHeader={false} showToolbar={false} />}</>;
  if (query.status === 'error') return <ErrorState message={errorMessage} onRetry={query.retry} />;
  return <>{children}</>;
}
