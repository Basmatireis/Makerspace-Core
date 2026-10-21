import './styles.scss';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { eventAccess } from './access';
import { EventEditPage } from './EventEditPage';
import { ParticipantView } from './ParticipantView';
import { eventQueryOptions } from './queries';

/** `/events/:eventId` is the participant view; organizers switch to the edit mode with `?mode=edit`. */
export function EventDetailPage() {
  const { eventId = '' } = useParams();
  const [params] = useSearchParams();
  const access = eventAccess(useCurrentUser());
  const query = useQuery(eventQueryOptions(eventId));
  if (access.organizer && params.get('mode') === 'edit') return <EventEditPage />;
  if (query.isPending)
    return (
      <PageShell title="Event" breadcrumbs={[{ label: 'Events', to: '/events' }]}>
        <InlineLoadingState label="Loading event" />
      </PageShell>
    );
  if (query.isError)
    return (
      <PageShell title="Event" breadcrumbs={[{ label: 'Events', to: '/events' }]}>
        <ErrorState
          title="Unable to load event"
          message="It may not exist or you may no longer have access."
          onRetry={() => void query.refetch()}
        />
      </PageShell>
    );
  return <ParticipantView event={query.data} />;
}
