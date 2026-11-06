import { Navigate, useParams } from 'react-router-dom';

/** The former page of one open day: the schedule of its period with that day selected. */
export function OpenDayRedirect() {
  const { periodId = '', openDayId = '' } = useParams();
  return <Navigate to={`/open-days/${periodId}?day=${encodeURIComponent(openDayId)}`} replace />;
}

/** The former `/open-days/manage` page: the Breaks tab of the period list. */
export function OpenDayBreaksRedirect() {
  return <Navigate to="/open-days?tab=breaks" replace />;
}
