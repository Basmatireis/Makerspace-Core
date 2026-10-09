import { Button, Checkbox, Form, InlineNotification, RadioButton, RadioButtonGroup, Stack, TextArea, Tile } from '@carbon/react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { useParams } from 'react-router-dom';
import { getPublicSurvey, submitPublicSurvey } from '../../api/generated/surveys/surveys';
import type { SurveyAnswerInput, SurveyOption } from '../../api/generated/models';
import { ErrorState, FullPageLoading } from '../../app/PageState';

type Values = Record<string, string | string[] | boolean>;

export function PublicSurveyPage() {
  const { token = '' } = useParams();
  const survey = useQuery({ queryKey: ['public-survey', token], queryFn: ({ signal }) => getPublicSurvey(token, { signal }), retry: false });
  const { control, handleSubmit } = useForm<Values>({ defaultValues: {} });
  const submit = useMutation({ mutationFn: (answers: SurveyAnswerInput[]) => submitPublicSurvey(token, { answers }) });
  if (survey.isPending) return <FullPageLoading label="Loading survey" />;
  if (survey.isError) return <main className="public-page"><ErrorState title="Survey unavailable" message="This survey link is invalid or has expired." /></main>;
  if (submit.isSuccess) return <main className="public-page"><Tile><Stack gap={4}><h1>Thank you</h1><p>Your response has been recorded.</p></Stack></Tile></main>;

  const onSubmit = (values: Values) => {
    const answers: SurveyAnswerInput[] = [];
    for (const question of survey.data.questions) {
      const value = values[question.id];
      if (value === undefined || value === '' || (Array.isArray(value) && value.length === 0)) continue;
      const answer: SurveyAnswerInput = { questionId: question.id, optionIds: [] };
      if (question.kind === 'single_choice') answer.optionIds = [String(value)];
      else if (question.kind === 'multiple_choice') answer.optionIds = value as string[];
      else if (question.kind === 'free_text') answer.textValue = String(value);
      else if (question.kind === 'rating') answer.numericValue = Number(value);
      else answer.booleanValue = value === true || value === 'true';
      answers.push(answer);
    }
    submit.mutate(answers);
  };

  return <main className="public-page"><Tile><Form onSubmit={handleSubmit(onSubmit)}><Stack gap={6}>
    <div><h1>{survey.data.title}</h1>{survey.data.introduction && <p>{survey.data.introduction}</p>}{survey.data.anonymous && <p>Your response is stored without a person identifier.</p>}</div>
    {survey.data.questions.map((question) => <Controller key={question.id} name={question.id} control={control} rules={{ required: question.required }} render={({ field, fieldState }) => <fieldset className="survey-question"><legend>{question.prompt}{question.required ? ' *' : ''}</legend>
      {question.kind === 'free_text' && <TextArea id={`question-${question.id}`} labelText="Your answer" value={String(field.value ?? '')} invalid={Boolean(fieldState.error)} invalidText="An answer is required" onChange={field.onChange} />}
      {(question.kind === 'single_choice' || question.kind === 'yes_no' || question.kind === 'rating') && <RadioButtonGroup name={question.id} valueSelected={field.value === undefined ? undefined : String(field.value)} onChange={(value) => field.onChange(value)}>
        {(question.kind === 'yes_no' ? [{ id: 'true', label: 'Yes' }, { id: 'false', label: 'No' }] : question.kind === 'rating' ? Array.from({ length: (question.ratingMax ?? 5) - (question.ratingMin ?? 1) + 1 }, (_, i) => ({ id: String((question.ratingMin ?? 1) + i), label: String((question.ratingMin ?? 1) + i) })) : question.options as SurveyOption[]).map((option) => <RadioButton key={option.id} id={`${question.id}-${option.id}`} value={option.id} labelText={option.label} />)}
      </RadioButtonGroup>}
      {question.kind === 'multiple_choice' && <Stack gap={3}>{(question.options as SurveyOption[]).map((option) => { const selected = Array.isArray(field.value) ? field.value : []; return <Checkbox key={option.id} id={`${question.id}-${option.id}`} labelText={option.label} checked={selected.includes(option.id)} onChange={(_, data) => field.onChange(data.checked ? [...selected, option.id] : selected.filter((id) => id !== option.id))} />; })}</Stack>}
      {fieldState.error && question.kind !== 'free_text' && <p className="form-error">An answer is required.</p>}
    </fieldset>} />)}
    {submit.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Response not submitted" subtitle={submit.error.message} />}
    <Button type="submit" disabled={submit.isPending}>Submit response</Button>
  </Stack></Form></Tile></main>;
}
