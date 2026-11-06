import { Navigate, useParams } from 'react-router-dom';
import { SchedulePage } from './SchedulePage';

/** `/open-days/:periodId`: the schedule of one period. Everything on it is derived from the person's permissions. */
export function OpenDayPeriodPage() {
  const { periodId = '' } = useParams();
  if (!periodId) return <Navigate to="/open-days" replace />;
  // The key resets the page's working copy and selection when another period is chosen.
  return <SchedulePage key={periodId} periodId={periodId} />;
}
