import { Button, Checkbox, Form, InlineNotification, NumberInput, Select, SelectItem, Stack, TextArea, TextInput, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useFieldArray, useForm } from 'react-hook-form';
import { useState } from 'react';
import { closeSurvey, createSurvey, listSurveys, publishSurvey, updateSurvey, updateSurveyTrigger } from '../../api/generated/surveys/surveys';
import type { Survey, SurveyQuestionKind } from '../../api/generated/models';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';

type BuilderQuestion = { kind: SurveyQuestionKind; prompt: string; required: boolean; optionsText: string; ratingMin: number; ratingMax: number };
type BuilderValues = { name: string; title: string; description: string; introduction: string; anonymous: boolean; questions: BuilderQuestion[] };
const surveyKey = ['surveys'] as const;
const blankQuestion: BuilderQuestion = { kind: 'free_text', prompt: '', required: false, optionsText: '', ratingMin: 1, ratingMax: 5 };

export function SurveyAdminPage() {
  const currentUser = useCurrentUser();
  const canManage = hasPermission(currentUser, PermissionId.surveysmanage);
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<Survey | undefined>();
  const query = useQuery({ queryKey: surveyKey, queryFn: ({ signal }) => listSurveys({ signal }) });
  const refresh = () => queryClient.invalidateQueries({ queryKey: surveyKey });
  return <PageShell title="Surveys" breadcrumbs={[{ label: 'Settings', to: '/settings' }]} description="Build reusable surveys and send them after visits."><Stack gap={6}>
    {query.isPending && <InlineLoadingState label="Loading surveys" />}{query.isError && <ErrorState title="Unable to load surveys" message="Check the connection and try again." onRetry={() => void query.refetch()} />}
    {query.data?.items.map((survey) => <SurveySummary key={survey.id} survey={survey} canManage={canManage} onChanged={refresh} onEdit={() => setEditing(survey)} />)}
    {canManage && <SurveyBuilder key={editing?.id ?? 'new'} survey={editing} onCancel={editing ? () => setEditing(undefined) : undefined} onSaved={async () => { setEditing(undefined); await refresh(); }} />}
  </Stack></PageShell>;
}

function SurveySummary({ survey, canManage, onChanged, onEdit }: { survey: Survey; canManage: boolean; onChanged: () => Promise<unknown>; onEdit: () => void }) {
  const publish = useMutation({ mutationFn: () => publishSurvey(survey.id, { expectedVersion: survey.version }), onSuccess: onChanged });
  const close = useMutation({ mutationFn: () => closeSurvey(survey.id, { expectedVersion: survey.version }), onSuccess: onChanged });
  const trigger = useMutation({ mutationFn: () => updateSurveyTrigger(survey.id, { enabled: !(survey.trigger?.enabled ?? false), delaySeconds: survey.trigger?.delaySeconds ?? 1800, cooldownDays: survey.trigger?.cooldownDays ?? 30, expectedVersion: survey.trigger?.version ?? 0 }), onSuccess: onChanged });
  return <Tile><Stack gap={4}><div className="section-heading"><div><h2>{survey.name}</h2><p>{survey.title} · revision {survey.revision} · {survey.questions.length} questions</p></div><strong>{survey.status}</strong></div>
    {canManage && <div className="button-cluster">{survey.status === 'draft' && <><Button size="sm" kind="secondary" onClick={onEdit}>Edit</Button><Button size="sm" disabled={publish.isPending} onClick={() => publish.mutate()}>Publish</Button></>}{survey.status === 'published' && <Button size="sm" kind="danger--tertiary" disabled={close.isPending} onClick={() => close.mutate()}>Close</Button>}<Button size="sm" kind="secondary" disabled={survey.status !== 'published' || trigger.isPending} onClick={() => trigger.mutate()}>{survey.trigger?.enabled ? 'Disable post-visit trigger' : 'Enable post-visit trigger'}</Button></div>}
    {(publish.isError || close.isError || trigger.isError) && <InlineNotification kind="error" lowContrast hideCloseButton title="Survey not changed" subtitle={(publish.error ?? close.error ?? trigger.error)?.message} />}
  </Stack></Tile>;
}

function SurveyBuilder({ onSaved, survey, onCancel }: { onSaved: () => Promise<unknown>; survey?: Survey; onCancel?: () => void }) {
  const { control, register, handleSubmit, formState: { errors } } = useForm<BuilderValues>({ defaultValues: survey ? {
    name: survey.name, title: survey.title, description: survey.description ?? '', introduction: survey.introduction ?? '', anonymous: survey.anonymous,
    questions: survey.questions.map((q) => ({ kind: q.kind, prompt: q.prompt, required: q.required, optionsText: q.options.map((o) => o.label).join('\n'), ratingMin: q.ratingMin ?? 1, ratingMax: q.ratingMax ?? 5 })),
  } : { name: '', title: '', description: '', introduction: '', anonymous: true, questions: [{ ...blankQuestion }] } });
  const questions = useFieldArray({ control, name: 'questions' });
  const save = useMutation({ mutationFn: (values: BuilderValues) => {
    const body = { name: values.name.trim(), title: values.title.trim(), description: values.description.trim() || null, introduction: values.introduction.trim() || null, anonymous: values.anonymous,
      questions: values.questions.map((q) => ({ kind: q.kind, prompt: q.prompt.trim(), required: q.required, options: ['single_choice', 'multiple_choice'].includes(q.kind) ? q.optionsText.split('\n').map((label) => ({ label: label.trim() })).filter((o) => o.label) : [], ratingMin: q.kind === 'rating' ? Number(q.ratingMin) : null, ratingMax: q.kind === 'rating' ? Number(q.ratingMax) : null })) };
    return survey ? updateSurvey(survey.id, { ...body, expectedVersion: survey.version }) : createSurvey(body);
  }, onSuccess: onSaved });
  return <Tile><Form onSubmit={handleSubmit((values) => save.mutate(values))}><Stack gap={5}><h2>{survey ? 'Edit survey' : 'Create survey'}</h2>
    <TextInput id="survey-name" labelText="Administrative name" invalid={Boolean(errors.name)} {...register('name', { required: true })} />
    <TextInput id="survey-title" labelText="Public title" invalid={Boolean(errors.title)} {...register('title', { required: true })} />
    <TextArea id="survey-description" labelText="Internal description" {...register('description')} /><TextArea id="survey-introduction" labelText="Introduction" {...register('introduction')} />
    <Controller name="anonymous" control={control} render={({ field }) => <Checkbox id="survey-anonymous" labelText="Store responses anonymously" checked={field.value} onChange={(_, data) => field.onChange(data.checked)} />} />
    {questions.fields.map((question, index) => <Tile key={question.id}><Stack gap={4}><div className="section-heading"><h3>Question {index + 1}</h3>{questions.fields.length > 1 && <Button kind="danger--ghost" size="sm" onClick={() => questions.remove(index)}>Remove</Button>}</div>
      <TextInput id={`survey-question-${index}`} labelText="Prompt" {...register(`questions.${index}.prompt`, { required: true })} />
      <Select id={`survey-kind-${index}`} labelText="Answer type" {...register(`questions.${index}.kind`)}><SelectItem value="single_choice" text="Single choice" /><SelectItem value="multiple_choice" text="Multiple choice" /><SelectItem value="free_text" text="Free text" /><SelectItem value="rating" text="Rating" /><SelectItem value="yes_no" text="Yes / no" /></Select>
      <TextArea id={`survey-options-${index}`} labelText="Choice options (one per line; used by choice questions)" {...register(`questions.${index}.optionsText`)} />
      <div className="button-cluster"><Controller name={`questions.${index}.ratingMin`} control={control} render={({ field }) => <NumberInput id={`survey-rating-min-${index}`} label="Rating minimum" min={0} max={9} value={field.value} onChange={(_event, state) => field.onChange(Number(state.value))} />} /><Controller name={`questions.${index}.ratingMax`} control={control} render={({ field }) => <NumberInput id={`survey-rating-max-${index}`} label="Rating maximum" min={1} max={10} value={field.value} onChange={(_event, state) => field.onChange(Number(state.value))} />} /></div>
      <Controller name={`questions.${index}.required`} control={control} render={({ field }) => <Checkbox id={`survey-required-${index}`} labelText="Required" checked={field.value} onChange={(_, data) => field.onChange(data.checked)} />} />
    </Stack></Tile>)}
    <Button kind="secondary" onClick={() => questions.append({ ...blankQuestion })}>Add question</Button>
    {save.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Survey not saved" subtitle={save.error.message} />}
    <div className="button-cluster">{onCancel && <Button type="button" kind="secondary" onClick={onCancel}>Cancel editing</Button>}<Button type="submit" disabled={save.isPending}>Save survey</Button></div>
  </Stack></Form></Tile>;
}
