import './styles.scss';
import { useLocation, useNavigate } from 'react-router-dom';
import { EventsPage, type EventListState } from './EventsPage';

export function EventCreatePage() {
  const location = useLocation();
  const navigate = useNavigate();
  const initialState = (location.state as { eventList?: EventListState } | null)?.eventList;

  return <EventsPage
    initialState={initialState}
    createOpen
    onCloseCreate={() => navigate('/events', {
      replace: true,
      state: initialState ? { eventList: initialState } : null,
    })}
  />;
}
