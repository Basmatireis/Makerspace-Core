import { Calendar, CheckmarkFilled, Education, Misuse, UserAvatarFilledAlt, WarningFilled } from '@carbon/icons-react';

export function CalendarLegend() {
  return (
    <div className="calendar-legend" aria-label="Calendar status legend">
      <div className="calendar-legend__group calendar-legend__group--context">
        <span className="calendar-legend__holiday"><Calendar size={14} aria-hidden="true" />Public holiday</span>
        <span className="calendar-legend__break"><Education size={14} aria-hidden="true" />Academic break</span>
        <span className="calendar-legend__cancelled"><Misuse size={14} aria-hidden="true" />Cancelled</span>
      </div>
      <div className="calendar-legend__group calendar-legend__group--staffing">
        <span className="calendar-legend__staffed"><CheckmarkFilled size={14} aria-hidden="true" />Fully staffed</span>
        <span className="calendar-legend__needs-supervisor"><WarningFilled size={14} aria-hidden="true" />Supervisor position open</span>
        <span className="calendar-legend__mine"><UserAvatarFilledAlt size={14} aria-hidden="true" />Your assignment</span>
      </div>
    </div>
  );
}
