import type { ReactNode } from 'react';
import { DataTableSkeleton } from '@carbon/react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ErrorState } from '../../../app/PageState';
import './shared.scss';

type Props<T> = {
  query: Pick<UseQueryResult<T>, 'status' | 'data' | 'refetch'>;
  loading?: ReactNode;
  errorMessage?: string;
  /** Rendered once the query has data; a function receives the loaded data. */
  children: ReactNode | ((data: T) => ReactNode);
};

/** Renders the loading skeleton and the error state (with retry) of a TanStack Query result consistently. */
export function QueryBoundary<T>({
  query,
  loading,
  errorMessage = 'The data could not be loaded.',
  children,
}: Props<T>) {
  if (query.status === 'pending')
    return <>{loading ?? <DataTableSkeleton columnCount={5} rowCount={6} showHeader={false} showToolbar={false} />}</>;
  if (query.status === 'error')
    return (
      <ErrorState
        message={errorMessage}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  return <>{typeof children === 'function' ? children(query.data as T) : children}</>;
}
