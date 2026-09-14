import type { CarbonIconType } from '@carbon/icons-react';
import type { ReactNode, Ref } from 'react';

type Props = {
  kind: 'staffed' | 'needs-supervisor' | 'needs-trainee' | 'cancelled' | 'planning';
  timeLabel: string;
  statusLabel: string;
  statusIcon: CarbonIconType;
  onActivate: () => void;
  assignmentLabel?: string;
  assignmentIcon?: CarbonIconType;
  actions?: ReactNode;
  mainRef?: Ref<HTMLButtonElement>;
  disabled?: boolean;
  dragging?: boolean;
  ariaLabel?: string;
};

export function CalendarEvent({ kind, timeLabel, statusLabel, statusIcon: StatusIcon, onActivate, assignmentLabel, assignmentIcon: AssignmentIcon, actions, mainRef, disabled = false, dragging = false, ariaLabel }: Props) {
  const content = (
    <>
      <span className="calendar-slot__time">{timeLabel}</span>
      <small className="calendar-slot__status"><StatusIcon size={12} aria-hidden="true" />{statusLabel}</small>
      {assignmentLabel && AssignmentIcon && <small className="calendar-slot__assignment"><AssignmentIcon size={12} aria-hidden="true" />{assignmentLabel}</small>}
    </>
  );
  const classes = `calendar-slot calendar-slot--${kind}${assignmentLabel ? ' calendar-slot--mine' : ''}${actions ? ' calendar-slot--editable' : ''}${dragging ? ' calendar-slot--dragging' : ''}`;

  if (!actions) {
    return <button ref={mainRef} type="button" className={classes} onClick={onActivate} disabled={disabled} aria-label={ariaLabel}>{content}</button>;
  }
  return (
    <div className={classes}>
      <button ref={mainRef} type="button" className="calendar-slot__main" onClick={onActivate} disabled={disabled} aria-label={ariaLabel}>{content}</button>
      <div className="calendar-slot__actions">{actions}</div>
    </div>
  );
}
