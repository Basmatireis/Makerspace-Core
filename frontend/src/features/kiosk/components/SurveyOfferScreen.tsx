import { Button, InlineNotification, Link, ProgressBar, TextArea } from '@carbon/react';
import { CheckmarkFilled, Email, Star, StarFilled } from '@carbon/icons-react';
import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
  terminalSurveyOfferAnswerNow,
  terminalSurveyOfferDecline,
  terminalSurveyOfferNever,
  terminalSurveyOfferSendEmail,
  terminalSurveyOfferSubmit,
} from '../../../api/generated/attendance/attendance';
import type { PublicSurvey, SurveyQuestion, TerminalSurveyOffer } from '../../../api/generated/models';
import { apiErrorCode } from '../../../api/http-client';
import { toAnswerInputs } from '../../surveys/surveyAnswers';
import { isAnswered, visibleQuestionIds, type AnswerValue } from '../../surveys/surveyModel';
import { firstName } from './format';
import { useIdleCountdown, useReturnCountdown } from './useIdleCountdown';

const returnAfterSeconds = 8;

type Step =
  { kind: 'offer' } | { kind: 'questions'; survey: PublicSurvey } | { kind: 'done'; how: 'answered' | 'mailed' };

/**
 * The tablet's check-out question: "Got a minute?" with answer now, send by e-mail or no thanks. The answers live
 * only in this component and are dropped when the person leaves or the tablet goes idle.
 */
export function SurveyOfferScreen({
  offer,
  displayName,
  resetSeconds,
  onDeclined,
  onHome,
}: {
  offer: TerminalSurveyOffer;
  displayName: string;
  resetSeconds: number;
  /** "No thanks" and "Don't ask me again": the parent shows the normal check-out result. */
  onDeclined: () => void;
  onHome: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: 'offer' });
  if (step.kind === 'offer')
    return (
      <OfferStep
        offer={offer}
        displayName={displayName}
        resetSeconds={resetSeconds}
        onQuestions={(survey) => setStep({ kind: 'questions', survey })}
        onMailed={() => setStep({ kind: 'done', how: 'mailed' })}
        onDeclined={onDeclined}
        onHome={onHome}
      />
    );
  if (step.kind === 'questions')
    return (
      <QuestionsStep
        token={offer.offerToken}
        survey={step.survey}
        resetSeconds={resetSeconds}
        onSent={() => setStep({ kind: 'done', how: 'answered' })}
        onHome={onHome}
      />
    );
  return <DoneStep how={step.how} displayName={displayName} onHome={onHome} />;
}

function errorMessage(error: unknown): string {
  switch (apiErrorCode(error)) {
    case 'no_email':
      return 'We have no e-mail address for you. Answer now or say no thanks.';
    default:
      return error instanceof Error && error.message ? error.message : 'Something went wrong. Please try again.';
  }
}

function OfferStep({
  offer,
  displayName,
  resetSeconds,
  onQuestions,
  onMailed,
  onDeclined,
  onHome,
}: {
  offer: TerminalSurveyOffer;
  displayName: string;
  resetSeconds: number;
  onQuestions: (survey: PublicSurvey) => void;
  onMailed: () => void;
  onDeclined: () => void;
  onHome: () => void;
}) {
  useIdleCountdown(onHome, resetSeconds);
  const token = offer.offerToken;
  const answerNow = useMutation({ mutationFn: () => terminalSurveyOfferAnswerNow(token), onSuccess: onQuestions });
  const sendEmail = useMutation({ mutationFn: () => terminalSurveyOfferSendEmail(token), onSuccess: onMailed });
  const decline = useMutation({ mutationFn: () => terminalSurveyOfferDecline(token), onSuccess: onDeclined });
  const never = useMutation({ mutationFn: () => terminalSurveyOfferNever(token), onSuccess: onDeclined });
  const busy = answerNow.isPending || sendEmail.isPending || decline.isPending || never.isPending;
  const error = answerNow.error ?? sendEmail.error ?? decline.error ?? never.error;
  return (
    <div className="tablet-offer">
      <p className="tablet-offer__seen">
        <CheckmarkFilled size={20} aria-hidden="true" /> Checked out · see you soon, {firstName(displayName)}
      </p>
      <h1 className="tablet-offer__title">Got a minute?</h1>
      <p className="tablet-offer__lead">
        {offer.questionCount === 1 ? 'One short question' : `${offer.questionCount} short questions`} about today:{' '}
        {offer.surveyName}.{offer.anonymous && ' Anonymous: your answers are not linked to you.'}
      </p>
      {error && (
        <InlineNotification kind="error" lowContrast hideCloseButton title="Not done" subtitle={errorMessage(error)} />
      )}
      <div className="tablet-offer__choices">
        {offer.canAnswerNow && (
          <Button size="2xl" disabled={busy} onClick={() => answerNow.mutate()}>
            Answer now
          </Button>
        )}
        {offer.canSendByEmail && (
          <Button size="2xl" kind="secondary" disabled={busy} onClick={() => sendEmail.mutate()}>
            Send it by e-mail
          </Button>
        )}
        <Button size="2xl" kind="secondary" disabled={busy} onClick={() => decline.mutate()}>
          No thanks
        </Button>
      </div>
      {offer.canStopAsking && (
        <Link
          href="#never"
          onClick={(event) => {
            event.preventDefault();
            if (!busy) never.mutate();
          }}
        >
          Don&apos;t ask me at check-out again
        </Link>
      )}
    </div>
  );
}

function ratingValues(question: SurveyQuestion): number[] {
  const min = question.ratingMin ?? 1;
  const max = question.ratingMax ?? 5;
  return Array.from({ length: Math.max(max - min + 1, 0) }, (_, index) => min + index);
}

function QuestionsStep({
  token,
  survey,
  resetSeconds,
  onSent,
  onHome,
}: {
  token: string;
  survey: PublicSurvey;
  resetSeconds: number;
  onSent: () => void;
  onHome: () => void;
}) {
  useIdleCountdown(onHome, resetSeconds);
  const [values, setValues] = useState<Record<string, AnswerValue>>({});
  const [index, setIndex] = useState(0);
  const questions = [...survey.questions].sort((a, b) => a.position - b.position);
  const visible = visibleQuestionIds(questions, values);
  const shown = questions.filter((question) => visible.has(question.id));
  const position = Math.min(index, Math.max(shown.length - 1, 0));
  const question = shown[position];
  const send = useMutation({
    mutationFn: () => terminalSurveyOfferSubmit(token, { answers: toAnswerInputs(questions, values) }),
    onSuccess: onSent,
  });
  if (!question) return null;
  const value = values[question.id];
  const last = position === shown.length - 1;
  const canGoOn = !question.required || isAnswered(value);
  const set = (next: AnswerValue) => setValues((current) => ({ ...current, [question.id]: next }));
  return (
    <div className="tablet-question">
      <ProgressBar
        label={`Question ${position + 1} of ${shown.length}`}
        value={position + 1}
        max={shown.length}
        size="small"
      />
      <h1 className="tablet-question__prompt" id="kiosk-question-prompt">
        {question.prompt}
      </h1>
      {!question.required && <p className="tablet-question__optional">Optional</p>}
      <QuestionInput key={question.id} question={question} value={value} onChange={set} />
      {send.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Not sent"
          subtitle={errorMessage(send.error)}
        />
      )}
      <div className="tablet-offer__choices">
        {position > 0 && (
          <Button size="2xl" kind="secondary" disabled={send.isPending} onClick={() => setIndex(position - 1)}>
            Back
          </Button>
        )}
        {last ? (
          <Button size="2xl" disabled={!canGoOn || send.isPending} onClick={() => send.mutate()}>
            Send
          </Button>
        ) : (
          <Button size="2xl" disabled={!canGoOn} onClick={() => setIndex(position + 1)}>
            Next
          </Button>
        )}
      </div>
    </div>
  );
}

function QuestionInput({
  question,
  value,
  onChange,
}: {
  question: SurveyQuestion;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
}) {
  if (question.kind === 'free_text')
    return (
      <TextArea
        id={`kiosk-question-${question.id}`}
        labelText={question.prompt}
        hideLabel
        rows={4}
        value={typeof value === 'string' ? value : ''}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  if (question.kind === 'rating') {
    const chosen = typeof value === 'string' ? Number(value) : null;
    const values = ratingValues(question);
    return (
      <div className="tablet-question__stars" role="group" aria-labelledby="kiosk-question-prompt">
        {values.map((number) => (
          <Button
            key={number}
            kind="ghost"
            size="2xl"
            className="tablet-question__star"
            aria-label={`${number} of ${values.at(-1)}`}
            aria-pressed={chosen === number}
            renderIcon={chosen !== null && number <= chosen ? StarFilled : Star}
            onClick={() => onChange(String(number))}
          />
        ))}
      </div>
    );
  }
  const options =
    question.kind === 'yes_no'
      ? [
          { id: 'true', label: 'Yes' },
          { id: 'false', label: 'No' },
        ]
      : question.options.map((option) => ({ id: option.id, label: option.label }));
  const multiple = question.kind === 'multiple_choice';
  const selected = Array.isArray(value) ? value : typeof value === 'string' ? [value] : [];
  return (
    <div className="tablet-question__choices" role="group" aria-labelledby="kiosk-question-prompt">
      {options.map((option) => {
        const on = selected.includes(option.id);
        return (
          <Button
            key={option.id}
            size="2xl"
            kind={on ? 'primary' : 'tertiary'}
            aria-pressed={on}
            onClick={() =>
              onChange(
                multiple ? (on ? selected.filter((id) => id !== option.id) : [...selected, option.id]) : option.id,
              )
            }
          >
            {option.label}
          </Button>
        );
      })}
    </div>
  );
}

function DoneStep({
  how,
  displayName,
  onHome,
}: {
  how: 'answered' | 'mailed';
  displayName: string;
  onHome: () => void;
}) {
  const left = useReturnCountdown(returnAfterSeconds, onHome);
  const Icon = how === 'mailed' ? Email : CheckmarkFilled;
  return (
    <div className="tablet-result">
      <Icon size={72} className="tablet-result__icon" aria-hidden="true" />
      <h1 className="tablet-result__title">
        {how === 'mailed' ? "It's on its way" : `Thank you, ${firstName(displayName)}!`}
      </h1>
      <p className="tablet-result__lead">
        {how === 'mailed'
          ? 'We sent the questions to your e-mail address. Answer whenever it suits you.'
          : 'Your answers help us run the makerspace better.'}
      </p>
      <Button size="2xl" kind="secondary" className="tablet-submit" onClick={onHome}>
        Done · {left} s
      </Button>
    </div>
  );
}
