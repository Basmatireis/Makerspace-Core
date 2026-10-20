import {
  InlineNotification,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  Tag,
} from '@carbon/react';
import type { UseQueryResult } from '@tanstack/react-query';
import type { LaborordnungStatus } from '../../../api/generated/models';
import type { getPersonMakerspaceStatus } from '../../../api/generated/people/people';
import { formatDateTimeRange } from '../../../app/dateTime';
import { InlineLoadingState } from '../../../app/PageState';
import { DetailSection } from '../PersonDetailComponents';

export function MakerspaceStatusSection({
  statusLabel,
  query,
}: {
  statusLabel: string;
  query: UseQueryResult<Awaited<ReturnType<typeof getPersonMakerspaceStatus>>>;
}) {
  return (
    <DetailSection
      title={statusLabel}
      className="person-makerspace-card"
      description="Upcoming participation and current Lab Rules acknowledgement."
    >
      {query.isPending && <InlineLoadingState label={`Loading ${statusLabel}`} />}
      {query.isError && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title={`${statusLabel} unavailable`}
          subtitle="Personal and account details are still available. Reload to try again."
        />
      )}
      {query.data?.laborordnungStatus && <LabRulesOverview status={query.data.laborordnungStatus} />}
      {query.data?.upcomingOpenDayAssignments && (
        <div className="person-open-days">
          <div className="section-heading">
            <h3>Upcoming Open Days</h3>
            <Tag type="cool-gray">{query.data.upcomingOpenDayAssignments.length}</Tag>
          </div>
          {query.data.upcomingOpenDayAssignments.length === 0 ? (
            <p className="section-description">No upcoming Open Day assignments.</p>
          ) : (
            <StructuredListWrapper isCondensed aria-label="Upcoming Open Day assignments">
              <StructuredListBody>
                {query.data.upcomingOpenDayAssignments.map((assignment) => (
                  <StructuredListRow key={assignment.assignmentId}>
                    <StructuredListCell>
                      <strong>{assignment.periodName}</strong>
                      <span className="person-open-days__time">
                        {formatDateTimeRange(assignment.startsAt, assignment.endsAt)}
                      </span>
                    </StructuredListCell>
                    <StructuredListCell>
                      <Tag type={assignment.role === 'supervisor' ? 'blue' : 'teal'}>{capitalize(assignment.role)}</Tag>
                    </StructuredListCell>
                  </StructuredListRow>
                ))}
              </StructuredListBody>
            </StructuredListWrapper>
          )}
        </div>
      )}
    </DetailSection>
  );
}

function LabRulesOverview({ status }: { status: LaborordnungStatus }) {
  const stateLabel =
    status.state === 'current'
      ? 'Current'
      : status.state === 'outdated'
        ? 'Acknowledgement outdated'
        : status.state === 'no_published_version'
          ? 'No published version'
          : 'Not required';
  const tagType = status.state === 'current' ? 'green' : status.actionRequired ? 'warm-gray' : 'gray';

  return (
    <section className="lab-rules-overview" aria-labelledby="person-lab-rules-heading">
      <div className="section-heading">
        <div>
          <h3 id="person-lab-rules-heading">Lab Rules</h3>
          <p className="section-description">Requirement mode: {status.mode.replace('_', ' ')}</p>
        </div>
        <div className="tag-list">
          <Tag type={tagType}>{stateLabel}</Tag>
          {status.requestId && <Tag type="purple">Confirmation pending</Tag>}
        </div>
      </div>
      <div className="lab-rules-overview__versions">
        <div>
          <span className="label">Current version</span>
          <strong>{status.currentVersion?.humanRevision ?? 'None published'}</strong>
        </div>
        <div>
          <span className="label">Acknowledged version</span>
          <strong>{status.latestConfirmedVersion?.humanRevision ?? 'None'}</strong>
        </div>
      </div>
    </section>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
