import {
  Link as CarbonLink,
  InlineNotification,
  StructuredListBody,
  StructuredListCell,
  StructuredListHead,
  StructuredListRow,
  StructuredListWrapper,
} from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { ListLaborordnungConfirmationsSort } from '../../api/generated/models';
import { formatDateTime } from '../../app/dateTime';
import { DetailSection } from '../../app/DetailSection';
import { InlineLoadingState } from '../../app/PageState';
import { confirmationMethodLabels, confirmationsQuery } from './queries';

const shown = 5;

/** The most recent Lab Rules confirmations of one person. Render only for people with `laborordnung.confirmations.read`. */
export function PersonConfirmationsSection({ personId }: { personId: string }) {
  const query = useQuery(
    confirmationsQuery({ personId, sort: ListLaborordnungConfirmationsSort.confirmedAt, page: 1, pageSize: shown }),
  );
  return (
    <DetailSection title="Lab Rules confirmations" description="The Lab Rules revisions this person has confirmed.">
      {query.isPending && <InlineLoadingState label="Loading confirmations" />}
      {query.isError && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Confirmations unavailable"
          subtitle="Reload the page to try again."
        />
      )}
      {query.data && query.data.items.length === 0 && (
        <p className="section-description">No Lab Rules have been confirmed yet.</p>
      )}
      {query.data && query.data.items.length > 0 && (
        <StructuredListWrapper isCondensed aria-label="Lab Rules confirmations">
          <StructuredListHead>
            <StructuredListRow head>
              <StructuredListCell head>Revision</StructuredListCell>
              <StructuredListCell head>Method</StructuredListCell>
              <StructuredListCell head>Confirmed at</StructuredListCell>
              <StructuredListCell head>Document reference</StructuredListCell>
            </StructuredListRow>
          </StructuredListHead>
          <StructuredListBody>
            {query.data.items.map((confirmation) => (
              <StructuredListRow key={confirmation.id}>
                <StructuredListCell>{confirmation.humanRevision}</StructuredListCell>
                <StructuredListCell>{confirmationMethodLabels[confirmation.method]}</StructuredListCell>
                <StructuredListCell>{formatDateTime(confirmation.confirmedAt)}</StructuredListCell>
                <StructuredListCell>{confirmation.physicalDocumentReference ?? '—'}</StructuredListCell>
              </StructuredListRow>
            ))}
          </StructuredListBody>
        </StructuredListWrapper>
      )}
      {query.data && query.data.total > shown && (
        <p className="section-description">
          Showing the latest {shown} of {query.data.total}.{' '}
          <CarbonLink as={Link} to="/settings/laborordnung?tab=confirmations">
            All confirmations
          </CarbonLink>
        </p>
      )}
    </DetailSection>
  );
}
