import { useQuery } from '@tanstack/react-query';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { requestQuery } from '../features/orders/queries';
import { FullPageLoading } from './PageState';

export function LegacyRedirect({ from, to }: { from: string; to: string }) {
  const location = useLocation();
  const suffix = location.pathname.slice(from.length);

  return <Navigate to={{ pathname: `${to}${suffix}`, search: location.search, hash: location.hash }} replace />;
}

/** The former request page: the invoice now lives on its order. */
export function ExternalInvoiceRedirect() {
  const { requestId = '' } = useParams();
  const request = useQuery({ ...requestQuery(requestId), enabled: !!requestId });
  if (request.isError || (request.data && !request.data.orderId)) return <Navigate to="/orders" replace />;
  if (!request.data) return <FullPageLoading label="Loading page" />;
  return <Navigate to={`/orders/${request.data.orderId}`} replace />;
}

export function OpenDayScheduleRedirect() {
  const { periodId = '' } = useParams();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('mode', 'edit');

  return (
    <Navigate
      to={{ pathname: `/open-days/${periodId}`, search: `?${params.toString()}`, hash: location.hash }}
      state={location.state}
      replace
    />
  );
}

/** Redirects a former URL carrying one ID to its new path; the query string and hash are dropped on purpose. */
export function IdRedirect({ param, to }: { param: string; to: (id: string) => string }) {
  const id = useParams()[param] ?? '';
  return <Navigate to={to(id)} replace />;
}
