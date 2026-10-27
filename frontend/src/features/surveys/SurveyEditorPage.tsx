import { useState } from 'react';
import {
  Button,
  Checkbox,
  Form,
  IconButton,
  InlineNotification,
  NumberInput,
  Select,
  SelectItem,
  Stack,
  TextArea,
  TextInput,
  Tile,
} from '@carbon/react';
import { Add, ArrowDown, ArrowUp, TrashCan } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useFieldArray, useForm, useWatch } from 'react-hook-form';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import { createSurvey, updateSurvey } from '../../api/generated/surveys/surveys';
import type { Survey, SurveyQuestionKind } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { ConditionEditor } from './ConditionEditor';
import { surveyKeys, surveyQuery } from './queries';
import {
  blankQuestion,
  draftFromSurvey,
  hasOptions,
  kindLabels,
  newKey,
  pruneConditions,
  toQuestionInputs,
  type DraftQuestion,
} from './surveyModel';
import './surveys.scss';

type EditorValues = {
  name: string;
  title: string;
  description: string;
  introduction: string;
  anonymous: boolean;
  questions: DraftQuestion[];
};

export function SurveyEditorPage() {
  const { surveyId } = useParams();
  const currentUser = useCurrentUser();
  if (!hasPermission(currentUser, PermissionId.surveysmanage)) return <Navigate to="/settings/surveys" replace />;
  return surveyId ? <ExistingSurveyEditor surveyId={surveyId} /> : <SurveyEditorForm />;
}

function ExistingSurveyEditor({ surveyId }: { surveyId: string }) {
  const query = useQuery(surveyQuery(surveyId));
  return (
    <QueryBoundary query={query} errorMessage="The survey could not be loaded.">
      {(survey) =>
        survey.responseCount > 0 ? (
          <Navigate to={`/settings/surveys/${survey.id}`} replace />
        ) : (
          <SurveyEditorForm survey={survey} />
        )
      }
    </QueryBoundary>
  );
}

const kinds = Object.keys(kindLabels) as SurveyQuestionKind[];

function SurveyEditorForm({ survey }: { survey?: Survey }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [warnings, setWarnings] = useState<string[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const form = useForm<EditorValues>({
    defaultValues: survey
      ? {
          name: survey.name,
          title: survey.title,
          description: survey.description ?? '',
          introduction: survey.introduction ?? '',
          anonymous: survey.anonymous,
          questions: draftFromSurvey(survey),
        }
      : { name: '', title: '', description: '', introduction: '', anonymous: true, questions: [blankQuestion()] },
  });
  const { control, register, handleSubmit, getValues, setValue, formState } = form;
  const { replace } = useFieldArray({ control, name: 'questions', keyName: 'fieldId' });
  const questions = useWatch({ control, name: 'questions' });

  // Structural changes go through here so that conditions broken by them are cleared with a visible warning.
  const apply = (next: DraftQuestion[]) => {
    const pruned = pruneConditions(next);
    replace(pruned.questions);
    setWarnings(
      pruned.cleared.map((item) => `The condition of question ${item.index + 1} was removed because ${item.reason}.`),
    );
  };
  const edit = (index: number, change: (question: DraftQuestion) => DraftQuestion) =>
    apply(getValues('questions').map((question, i) => (i === index ? change(question) : question)));
  const move = (index: number, delta: number) => {
    const next = [...getValues('questions')];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    apply(next);
  };

  const save = useMutation({
    mutationFn: (values: EditorValues) => {
      const built = toQuestionInputs(values.questions);
      if (built.problems.length > 0) {
        setProblems(built.problems.map((problem) => `Question ${problem.questionNumber}: ${problem.message}`));
        return Promise.resolve(undefined);
      }
      setProblems([]);
      const body = {
        name: values.name.trim(),
        title: values.title.trim(),
        description: values.description.trim() || null,
        introduction: values.introduction.trim() || null,
        anonymous: values.anonymous,
        questions: built.questions,
      };
      return survey ? updateSurvey(survey.id, { ...body, expectedVersion: survey.version }) : createSurvey(body);
    },
    onSuccess: async (saved) => {
      if (!saved) return;
      await queryClient.invalidateQueries({ queryKey: surveyKeys.all });
      navigate(`/settings/surveys/${saved.id}`);
    },
  });
  const back = survey ? `/settings/surveys/${survey.id}` : '/settings/surveys';

  return (
    <PageShell
      title={survey ? 'Edit survey' : 'New survey'}
      width="wide"
      breadcrumbs={[
        { label: 'Settings', to: '/settings' },
        { label: 'Surveys', to: '/settings/surveys' },
      ]}
    >
      <Form onSubmit={handleSubmit((values) => save.mutate(values))}>
        <Stack gap={6}>
          <TextInput
            id="survey-name"
            labelText="Administrative name"
            invalid={Boolean(formState.errors.name)}
            invalidText="A name is required"
            {...register('name', { required: true })}
          />
          <TextInput
            id="survey-title"
            labelText="Public title"
            invalid={Boolean(formState.errors.title)}
            invalidText="A title is required"
            {...register('title', { required: true })}
          />
          <TextArea id="survey-description" labelText="Internal description" {...register('description')} />
          <TextArea id="survey-introduction" labelText="Introduction" {...register('introduction')} />
          <Controller
            name="anonymous"
            control={control}
            render={({ field }) => (
              <Checkbox
                id="survey-anonymous"
                labelText="Store responses anonymously"
                checked={field.value}
                onChange={(_, data) => field.onChange(data.checked)}
              />
            )}
          />
          {warnings.length > 0 && (
            <InlineNotification
              kind="warning"
              lowContrast
              title="Conditions removed"
              subtitle={warnings.join(' ')}
              onCloseButtonClick={() => setWarnings([])}
            />
          )}
          {questions.map((question, index) => (
            <Tile key={question.key} className="survey-editor-question">
              <Stack gap={5}>
                <div className="survey-editor-question__heading">
                  <h2>Question {index + 1}</h2>
                  <div className="button-cluster">
                    <IconButton
                      label="Move up"
                      kind="ghost"
                      size="sm"
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp />
                    </IconButton>
                    <IconButton
                      label="Move down"
                      kind="ghost"
                      size="sm"
                      disabled={index === questions.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown />
                    </IconButton>
                    <IconButton
                      label="Remove question"
                      kind="ghost"
                      size="sm"
                      disabled={questions.length === 1}
                      onClick={() => apply(getValues('questions').filter((_, i) => i !== index))}
                    >
                      <TrashCan />
                    </IconButton>
                  </div>
                </div>
                <TextInput
                  id={`survey-question-${index}`}
                  labelText="Prompt"
                  invalid={Boolean(formState.errors.questions?.[index]?.prompt)}
                  invalidText="A prompt is required"
                  {...register(`questions.${index}.prompt`, { required: true })}
                />
                <Select
                  id={`survey-kind-${index}`}
                  labelText="Answer type"
                  value={question.kind}
                  onChange={(event) => {
                    const kind = event.target.value as SurveyQuestionKind;
                    edit(index, (current) => ({
                      ...current,
                      kind,
                      options:
                        hasOptions(kind) && current.options.length === 0
                          ? [
                              { key: newKey(), label: '' },
                              { key: newKey(), label: '' },
                            ]
                          : current.options,
                    }));
                  }}
                >
                  {kinds.map((kind) => (
                    <SelectItem key={kind} value={kind} text={kindLabels[kind]} />
                  ))}
                </Select>
                {hasOptions(question.kind) && (
                  <Stack gap={3}>
                    {question.options.map((option, optionIndex) => (
                      <div key={option.key} className="survey-editor-option">
                        <TextInput
                          id={`survey-option-${index}-${optionIndex}`}
                          labelText={`Option ${optionIndex + 1}`}
                          {...register(`questions.${index}.options.${optionIndex}.label`)}
                        />
                        <IconButton
                          label={`Remove option ${optionIndex + 1}`}
                          kind="ghost"
                          size="md"
                          onClick={() =>
                            edit(index, (current) => ({
                              ...current,
                              options: current.options.filter((_, i) => i !== optionIndex),
                            }))
                          }
                        >
                          <TrashCan />
                        </IconButton>
                      </div>
                    ))}
                    <div>
                      <Button
                        kind="tertiary"
                        size="sm"
                        renderIcon={Add}
                        onClick={() =>
                          edit(index, (current) => ({
                            ...current,
                            options: [...current.options, { key: newKey(), label: '' }],
                          }))
                        }
                      >
                        Add option
                      </Button>
                    </div>
                  </Stack>
                )}
                {question.kind === 'rating' && (
                  <div className="survey-editor-rating">
                    <Controller
                      name={`questions.${index}.ratingMin`}
                      control={control}
                      render={({ field }) => (
                        <NumberInput
                          id={`survey-rating-min-${index}`}
                          label="Lowest rating"
                          min={0}
                          max={9}
                          value={field.value}
                          onChange={(_event, state) => {
                            edit(index, (current) => ({ ...current, ratingMin: Number(state.value) }));
                          }}
                        />
                      )}
                    />
                    <Controller
                      name={`questions.${index}.ratingMax`}
                      control={control}
                      render={({ field }) => (
                        <NumberInput
                          id={`survey-rating-max-${index}`}
                          label="Highest rating"
                          min={1}
                          max={10}
                          value={field.value}
                          onChange={(_event, state) => {
                            edit(index, (current) => ({ ...current, ratingMax: Number(state.value) }));
                          }}
                        />
                      )}
                    />
                  </div>
                )}
                <Controller
                  name={`questions.${index}.required`}
                  control={control}
                  render={({ field }) => (
                    <Checkbox
                      id={`survey-required-${index}`}
                      labelText="Required"
                      checked={field.value}
                      onChange={(_, data) => field.onChange(data.checked)}
                    />
                  )}
                />
                <ConditionEditor
                  index={index}
                  questions={questions}
                  onChange={(condition) => setValue(`questions.${index}.condition`, condition, { shouldDirty: true })}
                />
              </Stack>
            </Tile>
          ))}
          <div>
            <Button
              kind="tertiary"
              renderIcon={Add}
              onClick={() => apply([...getValues('questions'), blankQuestion()])}
            >
              Add question
            </Button>
          </div>
          {problems.length > 0 && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Check the conditions"
              subtitle={problems.join(' ')}
            />
          )}
          {save.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Survey not saved"
              subtitle={save.error.message}
            />
          )}
          <div className="button-cluster">
            <Button type="button" kind="secondary" onClick={() => navigate(back)}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.isPending}>
              Save survey
            </Button>
          </div>
        </Stack>
      </Form>
    </PageShell>
  );
}
