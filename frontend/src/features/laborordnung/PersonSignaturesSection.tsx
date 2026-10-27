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
import { ListLaborordnungSignaturesSort } from '../../api/generated/models';
import { formatDate } from '../../app/dateTime';
import { DetailSection } from '../../app/DetailSection';
import { InlineLoadingState } from '../../app/PageState';
import { signaturesQuery } from './queries';

const shown = 5;

/** The most recent confirmed Lab Rules signatures of one person. Render only for people with `laborordnung.requests.read`. */
export function PersonSignaturesSection({ personId }: { personId: string }) {
  const query = useQuery(
    signaturesQuery({ personId, sort: ListLaborordnungSignaturesSort.confirmedAt, page: 1, pageSize: shown }),
  );
  return (
    <DetailSection title="Lab Rules signatures" description="Signed documents a supervisor confirmed for this person.">
      {query.isPending && <InlineLoadingState label="Loading signatures" />}
      {query.isError && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Signatures unavailable"
          subtitle="Reload the page to try again."
        />
      )}
      {query.data && query.data.items.length === 0 && (
        <p className="section-description">No signed Lab Rules have been confirmed yet.</p>
      )}
      {query.data && query.data.items.length > 0 && (
        <StructuredListWrapper isCondensed aria-label="Lab Rules signatures">
          <StructuredListHead>
            <StructuredListRow head>
              <StructuredListCell head>Revision</StructuredListCell>
              <StructuredListCell head>Signed</StructuredListCell>
              <StructuredListCell head>Document reference</StructuredListCell>
            </StructuredListRow>
          </StructuredListHead>
          <StructuredListBody>
            {query.data.items.map((signature) => (
              <StructuredListRow key={signature.id}>
                <StructuredListCell>{signature.humanRevision}</StructuredListCell>
                <StructuredListCell>{signature.signedDate ? formatDate(signature.signedDate) : '—'}</StructuredListCell>
                <StructuredListCell>{signature.physicalDocumentReference ?? '—'}</StructuredListCell>
              </StructuredListRow>
            ))}
          </StructuredListBody>
        </StructuredListWrapper>
      )}
      {query.data && query.data.total > shown && (
        <p className="section-description">
          Showing the latest {shown} of {query.data.total}.{' '}
          <CarbonLink as={Link} to="/settings/laborordnung?tab=signatures">
            All signatures
          </CarbonLink>
        </p>
      )}
    </DetailSection>
  );
}
