import { useQuery } from '@tanstack/react-query';
import { Navigate, useParams } from 'react-router-dom';
import { requestQuery } from '../features/orders/queries';
import { FullPageLoading } from './PageState';

/** The former request page: the invoice now lives on its order. */
export function ExternalInvoiceRedirect() {
  const { requestId = '' } = useParams();
  const request = useQuery({ ...requestQuery(requestId), enabled: !!requestId });
  if (request.isError || (request.data && !request.data.orderId)) return <Navigate to="/orders" replace />;
  if (!request.data) return <FullPageLoading label="Loading page" />;
  return <Navigate to={`/orders/${request.data.orderId}`} replace />;
}
