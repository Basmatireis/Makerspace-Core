import { useNavigate } from 'react-router-dom';
import { EventsPage } from './EventsPage';

/** `/events/new`: the list with the create dialog open. */
export function EventCreatePage() {
  const navigate = useNavigate();
  return <EventsPage createOpen onCloseCreate={() => navigate('/events', { replace: true })} />;
}
