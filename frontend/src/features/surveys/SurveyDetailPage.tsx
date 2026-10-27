import { useRef, useState } from 'react';
import { Button, InlineNotification, Tag, Tooltip } from '@carbon/react';
import { Edit, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import { closeSurvey, deleteSurvey, publishSurvey, reopenSurvey } from '../../api/generated/surveys/surveys';
import type { Survey } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { SettingsTabs, type SettingsTab } from '../settings/SettingsTabs';
import { SurveyDeliveryTab } from './SurveyDeliveryTab';
import { SurveyLinksTab } from './SurveyLinksTab';
import { SurveyQuestionsTab } from './SurveyQuestionsTab';
import { SurveyResultsTab } from './SurveyResultsTab';
import { statusLabels, statusTagTypes } from './presentation';
import { surveyKeys, surveyQuery } from './queries';
import './surveys.scss';

export function SurveyDetailPage() {
  const { surveyId = '' } = useParams();
  const query = useQuery(surveyQuery(surveyId));
  return (
    <QueryBoundary query={query} errorMessage="The survey could not be loaded.">
      {(survey) => <SurveyDetail survey={survey} />}
    </QueryBoundary>
  );
}

function SurveyDetail({ survey }: { survey: Survey }) {
  const currentUser = useCurrentUser();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canManage = hasPermission(currentUser, PermissionId.surveysmanage);
  const [confirm, setConfirm] = useState<'close' | 'delete' | null>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: surveyKeys.all });
  const change = useMutation({
    mutationFn: (action: 'publish' | 'close' | 'reopen') => {
      const body = { expectedVersion: survey.version };
      if (action === 'publish') return publishSurvey(survey.id, body);
      if (action === 'close') return closeSurvey(survey.id, body);
      return reopenSurvey(survey.id, body);
    },
    onSuccess: async () => {
      setConfirm(null);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () => deleteSurvey(survey.id),
    onSuccess: async () => {
      await refresh();
      navigate('/settings/surveys', { replace: true });
    },
  });
  const locked = survey.responseCount > 0;
  const lockReason = `This survey already has ${survey.responseCount} ${survey.responseCount === 1 ? 'response' : 'responses'}, so it can no longer be edited or deleted.`;

  const tabs: SettingsTab[] = [
    {
      key: 'questions',
      label: 'Questions',
      panel: <SurveyQuestionsTab survey={survey} lockReason={locked ? lockReason : undefined} />,
    },
    { key: 'results', label: 'Results', panel: <SurveyResultsTab survey={survey} /> },
    ...(canManage ? [{ key: 'links', label: 'Share links', panel: <SurveyLinksTab survey={survey} /> }] : []),
    {
      key: 'delivery',
      label: 'Automatic delivery',
      panel: <SurveyDeliveryTab survey={survey} canManage={canManage} onSaved={refresh} />,
    },
  ];

  const disabledAction = (label: string, icon: typeof Edit) => (
    <Tooltip label={lockReason} align="bottom">
      <span className="survey-disabled-action">
        <Button kind="tertiary" size="md" renderIcon={icon} disabled>
          {label}
        </Button>
      </span>
    </Tooltip>
  );

  return (
    <PageShell
      title={survey.name}
      titleAdornment={
        <Tag size="md" type={statusTagTypes[survey.status]}>
          {statusLabels[survey.status]}
        </Tag>
      }
      description={survey.description ?? survey.title}
      width="wide"
      breadcrumbs={[
        { label: 'Settings', to: '/settings' },
        { label: 'Surveys', to: '/settings/surveys' },
      ]}
      actions={
        canManage ? (
          <div className="button-cluster">
            {survey.status === 'draft' && (
              <Button kind="primary" disabled={change.isPending} onClick={() => change.mutate('publish')}>
                Publish
              </Button>
            )}
            {survey.status === 'published' && (
              <Button kind="tertiary" onClick={() => setConfirm('close')}>
                Close survey
              </Button>
            )}
            {survey.status === 'closed' && (
              <Button kind="primary" disabled={change.isPending} onClick={() => change.mutate('reopen')}>
                Reopen
              </Button>
            )}
            {locked ? (
              <>
                {disabledAction('Edit', Edit)}
                {disabledAction('Delete', TrashCan)}
              </>
            ) : (
              <>
                <Button
                  kind="tertiary"
                  renderIcon={Edit}
                  onClick={() => navigate(`/settings/surveys/${survey.id}/edit`)}
                >
                  Edit
                </Button>
                <Button
                  ref={deleteButton}
                  kind="danger--tertiary"
                  renderIcon={TrashCan}
                  onClick={() => setConfirm('delete')}
                >
                  Delete
                </Button>
              </>
            )}
          </div>
        ) : undefined
      }
    >
      {change.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          title="Survey not changed"
          subtitle={change.error.message}
          onCloseButtonClick={() => change.reset()}
        />
      )}
      <SettingsTabs label="Survey sections" tabs={tabs} />
      <DestructiveActionDialog
        open={confirm === 'close'}
        title="Close this survey?"
        confirmLabel="Close survey"
        pending={change.isPending}
        error={change.error?.message}
        onConfirm={() => change.mutate('close')}
        onClose={() => setConfirm(null)}
      >
        The survey stops accepting answers, automatic delivery is switched off and outstanding invitations are
        cancelled. You can reopen it later; the cancelled invitations stay cancelled.
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={confirm === 'delete'}
        title="Delete this survey?"
        confirmLabel="Delete survey"
        pending={remove.isPending}
        error={remove.error?.message}
        launcherButtonRef={deleteButton}
        onConfirm={() => remove.mutate()}
        onClose={() => setConfirm(null)}
      >
        The survey with its questions, share links and invitations is permanently deleted. This cannot be undone.
      </DestructiveActionDialog>
    </PageShell>
  );
}
