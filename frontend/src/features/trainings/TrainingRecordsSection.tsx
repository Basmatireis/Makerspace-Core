import { useState } from 'react';
import {
  Button,
  InlineNotification,
  StructuredListBody,
  StructuredListCell,
  StructuredListHead,
  StructuredListRow,
  StructuredListWrapper,
  Tag,
} from '@carbon/react';
import { Edit } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { TrainingRecord, TrainingStatus } from '../../api/generated/models';
import { formatDate } from '../../app/dateTime';
import { DetailSection } from '../../app/DetailSection';
import { InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { canSetTrainingRecords, trainingRecordsOptions, trainingStatusLabels } from './queries';
import { TrainingRecordModal } from './TrainingRecordModal';

const statusTagType: Record<TrainingStatus, 'cool-gray' | 'green' | 'blue'> = {
  not_trained: 'cool-gray',
  trained: 'green',
  trainer: 'blue',
};

/**
 * A person's status for every training. Readers see it; people with `training_records.update` change it for
 * everybody except themselves. Self readers get no internal notes from the API.
 */
export function TrainingRecordsSection({ personId, own = false }: { personId: string; own?: boolean }) {
  const currentUser = useCurrentUser();
  const canEdit = canSetTrainingRecords(currentUser, personId);
  const records = useQuery(trainingRecordsOptions(personId));
  const [editing, setEditing] = useState<TrainingRecord | null>(null);

  return (
    <DetailSection
      title="Trainings"
      description={
        own
          ? 'The trainings you completed. The lab management records them.'
          : 'Training status per training. Open days show the competencies of assigned supervisors.'
      }
    >
      {records.isPending && <InlineLoadingState label="Loading trainings" />}
      {records.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Trainings unavailable"
          subtitle="Reload the page to try again."
        />
      )}
      {records.data && records.data.items.length === 0 && (
        <p className="section-description">No trainings are set up yet.</p>
      )}
      {records.data && records.data.items.length > 0 && (
        <StructuredListWrapper isCondensed aria-label="Trainings" className="training-records">
          <StructuredListHead>
            <StructuredListRow head>
              <StructuredListCell head>Training</StructuredListCell>
              <StructuredListCell head>Status</StructuredListCell>
              <StructuredListCell head>Completed</StructuredListCell>
              {canEdit && <StructuredListCell head>{null}</StructuredListCell>}
            </StructuredListRow>
          </StructuredListHead>
          <StructuredListBody>
            {records.data.items.map((record) => (
              <StructuredListRow key={record.trainingId}>
                <StructuredListCell>
                  <span className="training-records__name">
                    {record.trainingName}
                    {!record.trainingActive && (
                      <Tag type="warm-gray" size="sm">
                        Inactive
                      </Tag>
                    )}
                  </span>
                  {record.notes && <span className="section-description">{record.notes}</span>}
                </StructuredListCell>
                <StructuredListCell>
                  <Tag type={statusTagType[record.status]}>{trainingStatusLabels[record.status]}</Tag>
                </StructuredListCell>
                <StructuredListCell>{record.completedOn ? formatDate(record.completedOn) : '—'}</StructuredListCell>
                {canEdit && (
                  <StructuredListCell>
                    <Button
                      kind="ghost"
                      size="sm"
                      hasIconOnly
                      renderIcon={Edit}
                      iconDescription={`Change status for ${record.trainingName}`}
                      tooltipPosition="left"
                      onClick={() => setEditing(record)}
                    />
                  </StructuredListCell>
                )}
              </StructuredListRow>
            ))}
          </StructuredListBody>
        </StructuredListWrapper>
      )}
      {canEdit && editing && (
        <TrainingRecordModal personId={personId} record={editing} onClose={() => setEditing(null)} />
      )}
    </DetailSection>
  );
}
