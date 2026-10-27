import { InlineNotification, Stack, Tag, Tile } from '@carbon/react';
import type { Survey } from '../../api/generated/models';
import { SettingsSection } from '../settings/SettingsPageLayout';
import { describeCondition, hasOptions, kindLabels } from './surveyModel';

export function SurveyQuestionsTab({ survey, lockReason }: { survey: Survey; lockReason?: string }) {
  return (
    <SettingsSection title={survey.title} description={survey.introduction ?? undefined}>
      <Stack gap={5}>
        {lockReason && (
          <InlineNotification kind="info" lowContrast hideCloseButton title="Locked" subtitle={lockReason} />
        )}
        <p className="settings-section__description">
          {survey.anonymous
            ? 'Responses are stored without a person identifier.'
            : 'Responses from invitations are linked to the invited person.'}
        </p>
        <ol className="survey-question-list">
          {[...survey.questions]
            .sort((a, b) => a.position - b.position)
            .map((question) => (
              <li key={question.id}>
                <Tile className="survey-question-card">
                  <div className="survey-question-card__heading">
                    <h3>
                      {question.position}. {question.prompt}
                    </h3>
                    <div className="survey-question-card__tags">
                      <Tag size="sm" type="outline">
                        {kindLabels[question.kind]}
                      </Tag>
                      {question.required && (
                        <Tag size="sm" type="blue">
                          Required
                        </Tag>
                      )}
                    </div>
                  </div>
                  {hasOptions(question.kind) && (
                    <ul className="survey-question-card__options">
                      {question.options.map((option) => (
                        <li key={option.id}>{option.label}</li>
                      ))}
                    </ul>
                  )}
                  {question.kind === 'rating' && (
                    <p className="settings-section__description">
                      Scale {question.ratingMin ?? 1} to {question.ratingMax ?? 5}
                    </p>
                  )}
                  {question.condition && (
                    <p className="survey-question-card__condition">
                      {describeCondition(
                        question,
                        survey.questions.find((candidate) => candidate.id === question.condition?.questionId),
                      )}
                    </p>
                  )}
                </Tile>
              </li>
            ))}
        </ol>
      </Stack>
    </SettingsSection>
  );
}
