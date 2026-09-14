import { Calendar, CheckmarkFilled, Education, Misuse, UserAvatarFilledAlt, WarningFilled } from '@carbon/icons-react';

export function CalendarLegend() {
  return (
    <div className="calendar-legend" aria-label="Calendar status legend">
      <span><CheckmarkFilled size={14} aria-hidden="true" />Fully staffed</span>
      <span><WarningFilled size={14} aria-hidden="true" />Supervisor position open</span>
      <span><UserAvatarFilledAlt size={14} aria-hidden="true" />Your assignment</span>
      <span><Misuse size={14} aria-hidden="true" />Cancelled</span>
      <span><Calendar size={14} aria-hidden="true" />Public holiday</span>
      <span><Education size={14} aria-hidden="true" />Academic break</span>
    </div>
  );
}
