import { describe, expect, it } from 'vitest';
import type { Survey, SurveyQuestion } from '../../api/generated/models';
import {
  draftFromSurvey,
  isConditionMet,
  pruneConditions,
  toQuestionInputs,
  visibleQuestionIds,
  type DraftQuestion,
} from './surveyModel';

const q1: SurveyQuestion = {
  id: 'q1',
  position: 1,
  kind: 'single_choice',
  prompt: 'Visited for',
  required: true,
  options: [
    { id: 'o1', position: 1, label: 'Printing' },
    { id: 'o2', position: 2, label: 'Woodwork' },
  ],
  condition: null,
};
const q2: SurveyQuestion = {
  id: 'q2',
  position: 2,
  kind: 'rating',
  prompt: 'Rate the printers',
  required: false,
  options: [],
  ratingMin: 1,
  ratingMax: 5,
  condition: {
    questionId: 'q1',
    questionPosition: 1,
    operator: 'one_of',
    optionIds: ['o1'],
    numericValue: null,
    booleanValue: null,
  },
};
const q3: SurveyQuestion = {
  id: 'q3',
  position: 3,
  kind: 'free_text',
  prompt: 'What went wrong?',
  required: true,
  options: [],
  condition: {
    questionId: 'q2',
    questionPosition: 2,
    operator: 'lte',
    optionIds: [],
    numericValue: 2,
    booleanValue: null,
  },
};
const survey = { questions: [q1, q2, q3] } as Survey;

describe('condition editor mapping', () => {
  it('maps output ids to input positions and back without losing conditions', () => {
    const drafts = draftFromSurvey(survey);
    const { questions, problems } = toQuestionInputs(drafts);
    expect(problems).toEqual([]);
    expect(questions[1].condition).toEqual({ questionPosition: 1, operator: 'one_of', optionPositions: [1] });
    expect(questions[2].condition).toEqual({ questionPosition: 2, operator: 'lte', numericValue: 2 });
    expect(questions[0].condition).toBeNull();
  });

  it('follows a reordered source by position', () => {
    const drafts = draftFromSurvey({
      questions: [q1, { ...q1, id: 'q0', position: 2 }, { ...q2, position: 3 }],
    } as Survey);
    const [first, second, third] = drafts;
    const { questions } = toQuestionInputs([second, first, third]);
    expect(questions[2].condition?.questionPosition).toBe(2);
  });

  it('clears conditions broken by reordering, deleting or retyping the source, and keeps the rest', () => {
    const [a, b, c] = draftFromSurvey(survey);
    expect(pruneConditions([b, a, c]).cleared).toEqual([
      { index: 0, reason: 'its source question no longer comes before it' },
    ]);
    expect(pruneConditions([b, c]).cleared.map((item) => item.index)).toEqual([0]);
    const retyped: DraftQuestion = { ...a, kind: 'free_text' };
    expect(pruneConditions([retyped, b, c]).cleared.map((item) => item.index)).toEqual([1]);
    expect(pruneConditions([a, b, c]).cleared).toEqual([]);
  });

  it('reports a rating condition outside the source scale', () => {
    const [a, b, c] = draftFromSurvey(survey);
    const { problems } = toQuestionInputs([a, b, { ...c, condition: { ...c.condition!, numericValue: 9 } }]);
    expect(problems).toHaveLength(1);
  });
});

describe('display conditions', () => {
  it('evaluates each operator', () => {
    expect(isConditionMet(q2.condition!, q1, 'o1')).toBe(true);
    expect(isConditionMet(q2.condition!, q1, 'o2')).toBe(false);
    expect(isConditionMet(q2.condition!, q1, undefined)).toBe(false);
    expect(
      isConditionMet(
        { ...q2.condition!, operator: 'includes_any', optionIds: ['o2'] },
        { ...q1, kind: 'multiple_choice' },
        ['o1', 'o2'],
      ),
    ).toBe(true);
    expect(isConditionMet(q3.condition!, q2, '2')).toBe(true);
    expect(isConditionMet(q3.condition!, q2, '3')).toBe(false);
    expect(isConditionMet({ ...q3.condition!, operator: 'gte' }, q2, '3')).toBe(true);
    expect(isConditionMet({ ...q3.condition!, operator: 'eq' }, q2, '2')).toBe(true);
    const yesNo = { ...q1, kind: 'yes_no' as const };
    const yes = { ...q2.condition!, operator: 'eq' as const, booleanValue: true };
    expect(isConditionMet(yes, yesNo, 'true')).toBe(true);
    expect(isConditionMet(yes, yesNo, 'false')).toBe(false);
  });

  it('hides questions whose source is hidden as well', () => {
    expect([...visibleQuestionIds([q1, q2, q3], { q1: 'o2', q2: '1' })]).toEqual(['q1']);
    expect([...visibleQuestionIds([q1, q2, q3], { q1: 'o1', q2: '1' })]).toEqual(['q1', 'q2', 'q3']);
    expect([...visibleQuestionIds([q1, q2, q3], { q1: 'o1', q2: '5' })]).toEqual(['q1', 'q2']);
  });
});
