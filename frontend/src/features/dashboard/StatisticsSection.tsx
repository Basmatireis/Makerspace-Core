import { Tile } from '@carbon/react';
import { Catalog, Chip, Events, Partnership, Printer, Time } from '@carbon/icons-react';
import type { ComponentType } from 'react';
import type { PersonalStatistics } from '../../api/generated/models';
import { APP_LOCALE } from '../../app/dateTime';
import { benchiesFor } from './balance';
import { memberFor, monthYear, plural } from './format';

const hoursFormat = new Intl.NumberFormat(APP_LOCALE, { maximumFractionDigits: 1 });

type Stat = {
  key: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  value: string;
  label: string;
  detail: string;
};

function StatTile({ stat }: { stat: Stat }) {
  const Icon = stat.icon;
  return (
    <Tile className="db-stat">
      <Icon size={20} className="db-stat__icon" aria-hidden />
      <span className="db-stat__value">{stat.value}</span>
      <span className="db-stat__label">{stat.label}</span>
      <span className="db-stat__detail">{stat.detail}</span>
    </Tile>
  );
}

function material(grams: number): string {
  return grams >= 1000 ? `${hoursFormat.format(grams / 1000)} kg` : `${hoursFormat.format(grams)} g`;
}

/** All-time figures. Time spent in the space is not tracked, so nothing here relies on it. */
export function StatisticsSection({ statistics, now }: { statistics: PersonalStatistics; now: number }) {
  const jobs = statistics.jobs;
  const benchies = jobs ? benchiesFor(jobs.materialGrams) : 0;
  const jobStats: Stat[] = jobs
    ? [
        {
          key: 'jobs',
          icon: Catalog,
          value: String(jobs.jobs),
          label: 'Jobs',
          detail:
            jobs.successRate === null
              ? jobs.jobs > 0
                ? 'No outcome recorded yet'
                : 'Your first job is waiting'
              : `${jobs.successRate} % came out right`,
        },
        {
          key: 'material',
          icon: Printer,
          value: material(jobs.materialGrams),
          label: 'Material printed',
          detail:
            benchies > 0
              ? `About ${benchies} ${benchies === 1 ? 'Benchy’s' : 'Benchys’'} worth`
              : 'Not a single Benchy yet',
        },
        {
          key: 'machine-time',
          icon: Chip,
          value: `${hoursFormat.format(jobs.machineSeconds / 3600)} h`,
          label: 'Machine time',
          detail: jobs.favouriteMachine
            ? `Favourite: ${jobs.favouriteMachine.name} (${plural(jobs.favouriteMachine.jobs, 'job')})`
            : 'No favourite machine yet',
        },
      ]
    : [];
  const stats: Stat[] = [
    ...jobStats,
    {
      key: 'open-days',
      icon: Partnership,
      value: String(statistics.openDaysStaffed),
      label: 'Open days staffed',
      detail:
        statistics.openDaysStaffed > 0
          ? `${hoursFormat.format(statistics.openDayHours)} hours keeping the doors open`
          : 'Supervisors keep the space open',
    },
    {
      key: 'shifts',
      icon: Events,
      value: String(statistics.eventShifts),
      label: 'Event shifts',
      detail:
        statistics.eventShifts > 0
          ? `${hoursFormat.format(statistics.eventShiftHours)} hours helping out`
          : 'Events always need helpers',
    },
    {
      key: 'member',
      icon: Time,
      value: memberFor(statistics.memberSince, now),
      label: 'Member for',
      detail: `Since ${monthYear(statistics.memberSince)}`,
    },
  ];
  return (
    <section aria-labelledby="db-stats-title">
      <h2 id="db-stats-title" className="db-section-title">
        Your makerspace so far
      </h2>
      <div className="db-stats">
        {stats.map((stat) => (
          <StatTile key={stat.key} stat={stat} />
        ))}
      </div>
    </section>
  );
}
