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
  const accessibleStatus = `${statusLabel}${assignmentLabel ? `, ${assignmentLabel}` : ''}`;
  const accessibleLabel = `${ariaLabel ?? timeLabel}, ${accessibleStatus}`;
  const content = (
    <>
      <span className="calendar-slot__time">{timeLabel}</span>
      <span className="calendar-slot__indicators" aria-hidden="true">
        <small className="calendar-slot__status" title={statusLabel}><StatusIcon size={14} /></small>
        {assignmentLabel && AssignmentIcon && <small className="calendar-slot__assignment" title={assignmentLabel}><AssignmentIcon size={14} /></small>}
      </span>
    </>
  );
  const classes = `calendar-slot calendar-slot--${kind}${assignmentLabel ? ' calendar-slot--mine' : ''}${actions ? ' calendar-slot--editable' : ''}${dragging ? ' calendar-slot--dragging' : ''}`;

  if (!actions) {
    return <button ref={mainRef} type="button" className={classes} onClick={onActivate} disabled={disabled} aria-label={accessibleLabel}>{content}</button>;
  }
  return (
    <div className={classes}>
      <button ref={mainRef} type="button" className="calendar-slot__main" onClick={onActivate} disabled={disabled} aria-label={accessibleLabel}>{content}</button>
      <div className="calendar-slot__actions">{actions}</div>
    </div>
  );
}
