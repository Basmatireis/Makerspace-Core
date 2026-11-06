import { Button } from '@carbon/react';
import { CheckmarkFilled } from '@carbon/icons-react';
import type { KioskNotice } from '../../../api/generated/models';
import { firstName, formatTime } from './format';
import { KioskNotices } from './KioskNotices';
import { useReturnCountdown } from './useIdleCountdown';

const returnAfterSeconds = 8;

export function ResultScreen({
  mode,
  displayName,
  at,
  notices = [],
  onDone,
}: {
  mode: 'check-in' | 'check-out';
  displayName: string;
  at: string;
  /** Rule notices for this person; one with `mustTap` keeps the screen until the person presses OK. */
  notices?: KioskNotice[];
  onDone: () => void;
}) {
  const mustTap = notices.some((notice) => notice.mustTap);
  const left = useReturnCountdown(returnAfterSeconds, onDone, mustTap);
  const name = firstName(displayName);
  return (
    <div className="tablet-result">
      <CheckmarkFilled size={72} className="tablet-result__icon" aria-hidden="true" />
      <h1 className="tablet-result__title">{mode === 'check-in' ? `Welcome, ${name}!` : `See you, ${name}!`}</h1>
      <p className="tablet-result__lead">
        {mode === 'check-in' ? 'Checked in' : 'Checked out'} at {formatTime(at)}.
      </p>
      <KioskNotices notices={notices} />
      <Button size="2xl" kind={mustTap ? 'primary' : 'secondary'} className="tablet-submit" onClick={onDone}>
        {mustTap ? 'OK' : `Done · ${left} s`}
      </Button>
    </div>
  );
}
