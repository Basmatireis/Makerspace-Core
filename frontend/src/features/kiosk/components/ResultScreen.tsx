import { Button } from '@carbon/react';
import { CheckmarkFilled } from '@carbon/icons-react';
import { firstName, formatTime } from './format';
import { useReturnCountdown } from './useIdleCountdown';

const returnAfterSeconds = 8;

export function ResultScreen({
  mode,
  displayName,
  at,
  onDone,
}: {
  mode: 'check-in' | 'check-out';
  displayName: string;
  at: string;
  onDone: () => void;
}) {
  const left = useReturnCountdown(returnAfterSeconds, onDone);
  const name = firstName(displayName);
  return (
    <div className="tablet-result">
      <CheckmarkFilled size={72} className="tablet-result__icon" aria-hidden="true" />
      <h1 className="tablet-result__title">{mode === 'check-in' ? `Welcome, ${name}!` : `See you, ${name}!`}</h1>
      <p className="tablet-result__lead">
        {mode === 'check-in' ? 'Checked in' : 'Checked out'} at {formatTime(at)}.
      </p>
      <Button size="2xl" kind="secondary" className="tablet-submit" onClick={onDone}>
        Done · {left} s
      </Button>
    </div>
  );
}
