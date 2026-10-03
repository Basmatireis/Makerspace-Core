import type { ReactNode } from 'react';
import type { OpenDayPeriod } from '../../api/generated/models';

type SummaryPeriod = Pick<
  OpenDayPeriod,
  | 'totalOpenDays'
  | 'fullyStaffedCount'
  | 'needsStaffCount'
  | 'openSupervisorPositions'
  | 'cancelledCount'
  | 'myAssignmentCount'
>;

export function OpenDayPeriodSummary({ period, actions }: { period: SummaryPeriod; actions?: ReactNode }) {
  const statistics = [
    { label: 'Total Open Days', value: period.totalOpenDays },
    { label: 'Fully staffed', value: period.fullyStaffedCount, className: 'status-good' },
    { label: 'Needs staff', value: period.needsStaffCount, className: 'status-bad' },
    { label: 'Open supervisor positions', value: period.openSupervisorPositions, className: 'status-bad' },
    { label: 'Cancelled', value: period.cancelledCount },
    { label: 'My Open Days', value: period.myAssignmentCount },
  ];

  return <section className="period-summary-bar" aria-label="Period summary">
    <dl className="period-summary-bar__stats">
      {statistics.map((statistic) => <div key={statistic.label}>
        <dt>{statistic.label}</dt>
        <dd className={statistic.className}>{statistic.value}</dd>
      </div>)}
    </dl>
    {actions && <div className="period-summary-bar__actions">{actions}</div>}
  </section>;
}
