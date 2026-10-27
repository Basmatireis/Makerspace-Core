import { Navigate, useLocation, useParams } from 'react-router-dom';

export function LegacyRedirect({ from, to }: { from: string; to: string }) {
  const location = useLocation();
  const suffix = location.pathname.slice(from.length);

  return <Navigate to={{ pathname: `${to}${suffix}`, search: location.search, hash: location.hash }} replace />;
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
