import type { SurveyAnswerInput, SurveyQuestion } from '../../api/generated/models';
import { isAnswered, visibleQuestionIds, type AnswerValue } from './surveyModel';

/**
 * The request answers for the given form values. Answers to hidden questions are rejected by the server, so only
 * questions that are visible with these values are sent, and only when answered.
 */
export function toAnswerInputs(questions: SurveyQuestion[], values: Record<string, AnswerValue>): SurveyAnswerInput[] {
  const visible = visibleQuestionIds(questions, values);
  const answers: SurveyAnswerInput[] = [];
  for (const question of questions) {
    const value = values[question.id];
    if (!visible.has(question.id) || !isAnswered(value)) continue;
    const answer: SurveyAnswerInput = { questionId: question.id, optionIds: [] };
    if (question.kind === 'single_choice') answer.optionIds = [String(value)];
    else if (question.kind === 'multiple_choice') answer.optionIds = value as string[];
    else if (question.kind === 'free_text') answer.textValue = String(value);
    else if (question.kind === 'rating') answer.numericValue = Number(value);
    else answer.booleanValue = value === 'true';
    answers.push(answer);
  }
  return answers;
}
