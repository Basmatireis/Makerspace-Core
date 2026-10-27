import { Button, Checkbox, Form, InlineNotification, ProgressBar, TextArea, TileGroup, RadioTile } from '@carbon/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Controller, useForm, useWatch } from 'react-hook-form';
import { Route, Routes, useParams } from 'react-router-dom';
import {
  getPublicSurvey,
  getPublicSurveyByLink,
  submitPublicSurvey,
  submitPublicSurveyByLink,
} from '../../api/generated/surveys/surveys';
import type { SurveyAnswerInput, SurveyQuestion } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { FullPageLoading } from '../../app/PageState';
import { isAnswered, visibleQuestionIds, type AnswerValue } from './surveyModel';
import './surveys.scss';

type Kind = 'invitation' | 'link';
type Values = Record<string, AnswerValue>;

/** `/survey/:token` opens an invitation, `/survey/link/:token` a share link; one lazily loaded unit serves both. */
export function PublicSurveyPage() {
  return (
    <Routes>
      <Route path="link/:token" element={<PublicSurvey kind="link" />} />
      <Route path=":token" element={<PublicSurvey kind="invitation" />} />
    </Routes>
  );
}

const unavailableByCode: Record<string, string> = {
  survey_link_inactive: 'This link has been deactivated.',
  survey_link_expired: 'This link has expired.',
  survey_link_full: 'This survey has received all the responses it can take.',
  survey_unavailable: 'This survey is not accepting answers any more.',
};

function describeUnavailable(error: unknown): { title: string; message: string } {
  if (error instanceof ApiError) {
    if (error.status === 410) {
      const code = (error.data as { code?: string } | undefined)?.code ?? '';
      return {
        title: 'Survey closed',
        message: unavailableByCode[code] ?? 'This survey is no longer available.',
      };
    }
    if (error.status === 404) return { title: 'Survey not found', message: 'This survey link is not valid.' };
    if (error.status === 429) return { title: 'Please wait', message: 'Too many requests. Try again in a minute.' };
  }
  return {
    title: 'Survey unavailable',
    message: 'The survey could not be loaded. Check the connection and try again.',
  };
}

function Message({ title, message }: { title: string; message: string }) {
  return (
    <main className="public-page">
      <div className="survey-public survey-public--message">
        <h1>{title}</h1>
        <p>{message}</p>
      </div>
    </main>
  );
}

function PublicSurvey({ kind }: { kind: Kind }) {
  const { token = '' } = useParams();
  const survey = useQuery({
    queryKey: ['public-survey', kind, token],
    queryFn: ({ signal }) =>
      kind === 'link' ? getPublicSurveyByLink(token, { signal }) : getPublicSurvey(token, { signal }),
    retry: false,
  });
  const submit = useMutation({
    mutationFn: (answers: SurveyAnswerInput[]) =>
      kind === 'link' ? submitPublicSurveyByLink(token, { answers }) : submitPublicSurvey(token, { answers }),
  });
  const { control, handleSubmit } = useForm<Values>({ defaultValues: {}, shouldUnregister: true });
  const values = useWatch({ control }) as Values;
  if (survey.isPending) return <FullPageLoading label="Loading survey" />;
  if (survey.isError) return <Message {...describeUnavailable(survey.error)} />;
  if (submit.isSuccess) return <Message title="Thank you" message="Your response has been recorded." />;
  if (submit.error instanceof ApiError && submit.error.status === 410)
    return <Message {...describeUnavailable(submit.error)} />;

  const questions = [...survey.data.questions].sort((a, b) => a.position - b.position);
  const visible = visibleQuestionIds(questions, values);
  const shown = questions.filter((question) => visible.has(question.id));
  const answered = shown.filter((question) => isAnswered(values[question.id])).length;

  const onSubmit = (formValues: Values) => {
    // Answers to hidden questions are rejected by the server, so only visible questions are sent.
    const visibleNow = visibleQuestionIds(questions, formValues);
    const answers: SurveyAnswerInput[] = [];
    for (const question of questions) {
      const value = formValues[question.id];
      if (!visibleNow.has(question.id) || !isAnswered(value)) continue;
      const answer: SurveyAnswerInput = { questionId: question.id, optionIds: [] };
      if (question.kind === 'single_choice') answer.optionIds = [String(value)];
      else if (question.kind === 'multiple_choice') answer.optionIds = value as string[];
      else if (question.kind === 'free_text') answer.textValue = String(value);
      else if (question.kind === 'rating') answer.numericValue = Number(value);
      else answer.booleanValue = value === 'true';
      answers.push(answer);
    }
    submit.mutate(answers);
  };

  return (
    <main className="public-page">
      <Form className="survey-public" onSubmit={handleSubmit(onSubmit)} noValidate>
        <header>
          <h1>{survey.data.title}</h1>
          {survey.data.introduction && <p>{survey.data.introduction}</p>}
          {survey.data.anonymous && (
            <p className="survey-public__note">Your response is stored without a person identifier.</p>
          )}
        </header>
        {shown.map((question, index) => (
          <Controller
            key={question.id}
            name={question.id}
            control={control}
            rules={{ validate: (value) => !question.required || isAnswered(value as AnswerValue) }}
            render={({ field, fieldState }) => (
              <QuestionField
                question={question}
                number={index + 1}
                value={field.value as AnswerValue}
                invalid={Boolean(fieldState.error)}
                onChange={field.onChange}
              />
            )}
          />
        ))}
        {submit.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Response not submitted"
            subtitle={submit.error.message}
          />
        )}
        <div className="survey-public__bar">
          <ProgressBar
            label="Progress"
            hideLabel
            size="small"
            value={answered}
            max={Math.max(shown.length, 1)}
            helperText={`${answered} of ${shown.length} answered`}
          />
          <Button type="submit" size="xl" className="survey-public__submit" disabled={submit.isPending}>
            Submit response
          </Button>
        </div>
      </Form>
    </main>
  );
}

function QuestionField({
  question,
  number,
  value,
  invalid,
  onChange,
}: {
  question: SurveyQuestion;
  number: number;
  value: AnswerValue;
  invalid: boolean;
  onChange: (value: AnswerValue) => void;
}) {
  const label = `${number}. ${question.prompt}${question.required ? ' *' : ''}`;
  const id = `question-${question.id}`;
  const error = invalid && <p className="survey-public__error">An answer is required.</p>;
  if (question.kind === 'free_text')
    return (
      <div className="survey-public__question">
        <TextArea
          id={id}
          labelText={label}
          rows={4}
          value={typeof value === 'string' ? value : ''}
          invalid={invalid}
          invalidText="An answer is required."
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    );
  if (question.kind === 'multiple_choice') {
    const selected = Array.isArray(value) ? value : [];
    return (
      <fieldset className="survey-public__question">
        <legend>{label}</legend>
        <div className="survey-public__choices">
          {question.options.map((option) => (
            <Checkbox
              key={option.id}
              id={`${id}-${option.id}`}
              labelText={option.label}
              checked={selected.includes(option.id)}
              onChange={(_event, data) =>
                onChange(
                  data.checked
                    ? [...selected.filter((item) => item !== option.id), option.id]
                    : selected.filter((item) => item !== option.id),
                )
              }
            />
          ))}
        </div>
        {error}
      </fieldset>
    );
  }
  const choices =
    question.kind === 'yes_no'
      ? [
          { id: 'true', label: 'Yes' },
          { id: 'false', label: 'No' },
        ]
      : question.kind === 'rating'
        ? Array.from({ length: (question.ratingMax ?? 5) - (question.ratingMin ?? 1) + 1 }, (_, i) => ({
            id: String((question.ratingMin ?? 1) + i),
            label: String((question.ratingMin ?? 1) + i),
          }))
        : question.options.map((option) => ({ id: option.id, label: option.label }));
  return (
    <div className={`survey-public__question survey-public__question--${question.kind}`}>
      <TileGroup
        legend={label}
        name={question.id}
        valueSelected={typeof value === 'string' ? value : undefined}
        onChange={(next) => onChange(String(next))}
      >
        {choices.map((choice) => (
          <RadioTile key={choice.id} id={`${id}-${choice.id}`} value={choice.id}>
            {choice.label}
          </RadioTile>
        ))}
      </TileGroup>
      {error}
    </div>
  );
}
