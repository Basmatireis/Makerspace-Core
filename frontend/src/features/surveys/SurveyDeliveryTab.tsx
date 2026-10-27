import { Stack } from '@carbon/react';
import type { Survey } from '../../api/generated/models';
import { SettingsSection } from '../settings/SettingsPageLayout';
import { SurveyTriggerForm } from './SurveyTriggerForm';
import { describeTrigger } from './triggerFormat';

export function SurveyDeliveryTab({
  survey,
  canManage,
  onSaved,
}: {
  survey: Survey;
  canManage: boolean;
  onSaved: () => Promise<unknown>;
}) {
  return (
    <SettingsSection
      title="Automatic delivery"
      description="Invite visitors to this survey by email after they check out."
    >
      <Stack gap={5}>
        <p>{describeTrigger(survey.trigger)}</p>
        {canManage && survey.status !== 'closed' && (
          <SurveyTriggerForm key={survey.trigger?.version ?? 0} survey={survey} onSaved={onSaved} />
        )}
        {canManage && survey.status === 'closed' && <p>Reopen the survey to change its automatic delivery.</p>}
      </Stack>
    </SettingsSection>
  );
}
