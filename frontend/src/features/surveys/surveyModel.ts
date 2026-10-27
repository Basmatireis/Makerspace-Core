import type {
  Survey,
  SurveyCondition,
  SurveyConditionInput,
  SurveyConditionOperator,
  SurveyQuestion,
  SurveyQuestionInput,
  SurveyQuestionKind,
} from '../../api/generated/models';

export const kindLabels: Record<SurveyQuestionKind, string> = {
  single_choice: 'Single choice',
  multiple_choice: 'Multiple choice',
  free_text: 'Free text',
  rating: 'Rating',
  yes_no: 'Yes / no',
};

export const hasOptions = (kind: SurveyQuestionKind) => kind === 'single_choice' || kind === 'multiple_choice';
/** Free-text answers cannot be compared, so such a question can never be the source of a condition. */
export const canBeConditionSource = (kind: SurveyQuestionKind) => kind !== 'free_text';

export function operatorsFor(kind: SurveyQuestionKind): { value: SurveyConditionOperator; label: string }[] {
  switch (kind) {
    case 'single_choice':
      return [{ value: 'one_of', label: 'is one of' }];
    case 'multiple_choice':
      return [{ value: 'includes_any', label: 'includes any of' }];
    case 'rating':
      return [
        { value: 'lte', label: 'is at most' },
        { value: 'gte', label: 'is at least' },
        { value: 'eq', label: 'is exactly' },
      ];
    case 'yes_no':
      return [{ value: 'eq', label: 'is' }];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Editor drafts. Conditions refer to questions and options by a stable client key (the id of a saved question or
// option, a counter for new ones) so that reordering cannot silently re-target them. The API wants 1-based positions
// on input and returns ids, so `draftFromSurvey` and `toQuestionInputs` translate between the two.
// ---------------------------------------------------------------------------------------------------------------

export type DraftOption = { key: string; label: string };
export type DraftCondition = {
  sourceKey: string;
  operator: SurveyConditionOperator;
  optionKeys: string[];
  numericValue: number;
  booleanValue: boolean;
};
export type DraftQuestion = {
  key: string;
  kind: SurveyQuestionKind;
  prompt: string;
  required: boolean;
  options: DraftOption[];
  ratingMin: number;
  ratingMax: number;
  condition: DraftCondition | null;
};

let keyCounter = 0;
export const newKey = () => `draft-${++keyCounter}`;

export const blankQuestion = (): DraftQuestion => ({
  key: newKey(),
  kind: 'free_text',
  prompt: '',
  required: false,
  options: [],
  ratingMin: 1,
  ratingMax: 5,
  condition: null,
});

export function draftFromSurvey(survey: Survey): DraftQuestion[] {
  return [...survey.questions]
    .sort((a, b) => a.position - b.position)
    .map((question) => ({
      key: question.id,
      kind: question.kind,
      prompt: question.prompt,
      required: question.required,
      options: [...question.options]
        .sort((a, b) => a.position - b.position)
        .map((option) => ({ key: option.id, label: option.label })),
      ratingMin: question.ratingMin ?? 1,
      ratingMax: question.ratingMax ?? 5,
      condition: question.condition
        ? {
            sourceKey: question.condition.questionId,
            operator: question.condition.operator,
            optionKeys: question.condition.optionIds,
            numericValue: question.condition.numericValue ?? question.ratingMin ?? 1,
            booleanValue: question.condition.booleanValue ?? true,
          }
        : null,
    }));
}

export type ClearedCondition = { index: number; reason: string };

/**
 * Drops every condition that no longer makes sense after the questions were reordered, removed or edited, and says
 * which ones and why. Conditions that merely lost some of their options keep the remaining ones.
 */
export function pruneConditions(questions: DraftQuestion[]): {
  questions: DraftQuestion[];
  cleared: ClearedCondition[];
} {
  const cleared: ClearedCondition[] = [];
  const next = questions.map((question, index) => {
    const condition = question.condition;
    if (!condition) return question;
    const sourceIndex = questions.findIndex((candidate) => candidate.key === condition.sourceKey);
    const source = questions[sourceIndex];
    const fail = (reason: string) => {
      cleared.push({ index, reason });
      return { ...question, condition: null };
    };
    if (!source) return fail('its source question was removed');
    if (sourceIndex >= index) return fail('its source question no longer comes before it');
    if (!canBeConditionSource(source.kind)) return fail('its source question is now a free-text question');
    if (!operatorsFor(source.kind).some((operator) => operator.value === condition.operator))
      return fail('the answer type of its source question changed');
    if (hasOptions(source.kind)) {
      const optionKeys = condition.optionKeys.filter((key) => source.options.some((option) => option.key === key));
      if (optionKeys.length === 0) return fail('the options it referred to were removed');
      return optionKeys.length === condition.optionKeys.length
        ? question
        : { ...question, condition: { ...condition, optionKeys } };
    }
    if (
      source.kind === 'rating' &&
      (condition.numericValue < source.ratingMin || condition.numericValue > source.ratingMax)
    )
      return fail('the rating scale of its source question changed');
    return question;
  });
  return { questions: next, cleared };
}

export type RequestProblem = { questionNumber: number; message: string };

/** Builds the API input: blank options are dropped, source questions and options become 1-based positions. */
export function toQuestionInputs(drafts: DraftQuestion[]): {
  questions: SurveyQuestionInput[];
  problems: RequestProblem[];
} {
  const cleaned = drafts.map((question) => ({
    ...question,
    prompt: question.prompt.trim(),
    options: hasOptions(question.kind)
      ? question.options
          .map((option) => ({ ...option, label: option.label.trim() }))
          .filter((option) => option.label !== '')
      : [],
  }));
  const problems: RequestProblem[] = [];
  const questions = cleaned.map((question, index): SurveyQuestionInput => {
    const rating = question.kind === 'rating';
    const input: SurveyQuestionInput = {
      kind: question.kind,
      prompt: question.prompt,
      required: question.required,
      options: question.options.map((option) => ({ label: option.label })),
      ratingMin: rating ? Number(question.ratingMin) : null,
      ratingMax: rating ? Number(question.ratingMax) : null,
      condition: null,
    };
    const condition = question.condition;
    if (!condition) return input;
    const sourceIndex = cleaned.findIndex((candidate) => candidate.key === condition.sourceKey);
    const source = cleaned[sourceIndex];
    const problem = (message: string) => problems.push({ questionNumber: index + 1, message });
    if (!source || sourceIndex >= index) {
      problem('The condition must refer to an earlier question.');
      return input;
    }
    const mapped: SurveyConditionInput = { questionPosition: sourceIndex + 1, operator: condition.operator };
    if (hasOptions(source.kind)) {
      const positions = condition.optionKeys
        .map((key) => source.options.findIndex((option) => option.key === key) + 1)
        .filter((position) => position > 0);
      if (positions.length === 0) problem('The condition needs at least one option.');
      mapped.optionPositions = positions;
    } else if (source.kind === 'rating') {
      if (condition.numericValue < source.ratingMin || condition.numericValue > source.ratingMax)
        problem('The condition value is outside the rating scale of its source question.');
      mapped.numericValue = condition.numericValue;
    } else if (source.kind === 'yes_no') {
      mapped.booleanValue = condition.booleanValue;
    }
    return { ...input, condition: mapped };
  });
  return { questions, problems };
}

// ---------------------------------------------------------------------------------------------------------------
// Display conditions on the fill-out page.
// ---------------------------------------------------------------------------------------------------------------

/** Single choice: option id, multiple choice: option ids, rating: the number as text, yes/no: "true"/"false". */
export type AnswerValue = string | string[] | undefined;
export const isAnswered = (value: AnswerValue) =>
  value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0);

export function isConditionMet(condition: SurveyCondition, source: SurveyQuestion, value: AnswerValue): boolean {
  if (!isAnswered(value)) return false;
  switch (source.kind) {
    case 'single_choice':
      return typeof value === 'string' && condition.optionIds.includes(value);
    case 'multiple_choice':
      return Array.isArray(value) && value.some((id) => condition.optionIds.includes(id));
    case 'yes_no':
      return condition.booleanValue != null && (value === 'true') === condition.booleanValue;
    case 'rating': {
      const answer = Number(value);
      const expected = condition.numericValue;
      if (expected == null || Number.isNaN(answer)) return false;
      if (condition.operator === 'lte') return answer <= expected;
      if (condition.operator === 'gte') return answer >= expected;
      return answer === expected;
    }
    default:
      return false;
  }
}

/**
 * Ids of the questions to show, evaluated in order like the server does: a question whose source is hidden is hidden
 * as well. Only these questions may be required or submitted.
 */
export function visibleQuestionIds(questions: SurveyQuestion[], answers: Record<string, AnswerValue>): Set<string> {
  const visible = new Set<string>();
  const byId = new Map(questions.map((question) => [question.id, question]));
  for (const question of questions) {
    const condition = question.condition;
    if (!condition) {
      visible.add(question.id);
      continue;
    }
    const source = byId.get(condition.questionId);
    if (source && visible.has(source.id) && isConditionMet(condition, source, answers[source.id]))
      visible.add(question.id);
  }
  return visible;
}

export function describeCondition(question: SurveyQuestion, source: SurveyQuestion | undefined): string {
  const condition = question.condition;
  if (!condition || !source) return '';
  const operator = operatorsFor(source.kind).find((item) => item.value === condition.operator)?.label ?? '';
  const value = hasOptions(source.kind)
    ? condition.optionIds
        .map((id) => source.options.find((option) => option.id === id)?.label ?? '')
        .filter(Boolean)
        .map((label) => `“${label}”`)
        .join(', ')
    : source.kind === 'rating'
      ? String(condition.numericValue ?? '')
      : condition.booleanValue
        ? 'Yes'
        : 'No';
  return `Shown only if question ${source.position} ${operator} ${value}`;
}
