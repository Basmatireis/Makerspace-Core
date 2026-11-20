import { Chip, Document, Renew, Tools, UserMultiple } from '@carbon/icons-react';
import type { ComponentType, ReactNode } from 'react';
import type { MaterialDimension, PersonalStatistics } from '../../api/generated/models';
import { APP_LOCALE, APP_TIME_ZONE } from '../../app/dateTime';
import { benchiesFor } from './balance';
import { memberFor, plural } from './format';

const numberFormat = new Intl.NumberFormat(APP_LOCALE, { maximumFractionDigits: 1 });
const monthFormat = new Intl.DateTimeFormat(APP_LOCALE, { month: 'short', year: 'numeric', timeZone: APP_TIME_ZONE });
const dayFormat = new Intl.DateTimeFormat(APP_LOCALE, { day: 'numeric', month: 'short', timeZone: APP_TIME_ZONE });

/** A football pitch of about 105 × 68 m, in cm² (the base unit of area). */
const FOOTBALL_FIELD_CM2 = 7140 * 10_000;

const ROLE_LABEL = { supervisor: 'Supervisor', trainee: 'Trainee', visitor: 'Visitor' } as const;

const hours = (seconds: number) => `${numberFormat.format(Math.round(seconds / 360) / 10)} h`;

/** An amount in the base unit of its dimension (g, mm, cm², ml, piece), in the unit that reads best. */
function materialAmount(amount: number, dimension: MaterialDimension): string {
  const scaled = (value: number, unit: string) => `${numberFormat.format(value)} ${unit}`;
  switch (dimension) {
    case 'mass':
      return amount >= 1000 ? scaled(amount / 1000, 'kg') : scaled(amount, 'g');
    case 'length':
      return amount >= 1000
        ? scaled(amount / 1000, 'm')
        : amount >= 10
          ? scaled(amount / 10, 'cm')
          : scaled(amount, 'mm');
    case 'area':
      return amount >= 10_000 ? scaled(amount / 10_000, 'm²') : scaled(amount, 'cm²');
    case 'volume':
      return amount >= 1000 ? scaled(amount / 1000, 'l') : scaled(amount, 'ml');
    default:
      return plural(Math.round(amount), 'piece');
  }
}

/** "about 3 Benchys and 1.2 % of a football field worth of material". */
function materialFun(grams: number, areaCm2: number): string {
  const benchies = benchiesFor(grams);
  const parts = benchies > 0 ? [`about ${benchies} ${benchies === 1 ? 'Benchy' : 'Benchys'}`] : [];
  if (areaCm2 > 0) {
    const fields = areaCm2 / FOOTBALL_FIELD_CM2;
    const percent = fields * 100;
    parts.push(
      fields >= 1
        ? `${numberFormat.format(fields)} football fields`
        : `${new Intl.NumberFormat(APP_LOCALE, { maximumFractionDigits: percent < 0.1 ? 2 : 1 }).format(percent)} % of a football field`,
    );
  }
  return parts.length > 0 ? `Used ${parts.join(' and ')} worth of material` : 'Not a single Benchy yet';
}

function Stat({
  icon: Icon,
  children,
  more,
  className,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  children: ReactNode;
  more?: ReactNode;
  className?: string;
}) {
  return (
    <div className={`db-stat${className ? ` ${className}` : ''}`}>
      <Icon size={20} className="db-stat__icon" aria-hidden />
      {children}
      {more && <dl className="db-stat__more">{more}</dl>}
    </div>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="db-kv">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

/** All-time figures. Time spent in the space is not tracked, so nothing here relies on it. */
export function StatisticsSection({ statistics, now }: { statistics: PersonalStatistics; now: number }) {
  const jobs = statistics.jobs;
  const membership = statistics.membership;
  const staffedHours = statistics.openDayHours + statistics.eventShiftHours;
  const thisMonth = jobs?.jobsPerMonth.at(-1)?.jobs ?? 0;
  const topJobs = Math.max(1, ...(jobs?.materials.map((material) => material.jobs) ?? []));
  const area = (jobs?.materials ?? [])
    .filter((material) => material.dimension === 'area')
    .reduce((sum, material) => sum + material.amount, 0);

  return (
    <section aria-labelledby="db-stats-title" className="db-statsection">
      <h2 id="db-stats-title" className="db-section-title">
        Your makerspace so far
      </h2>
      <div className={`db-statrow${jobs ? '' : ' db-statrow--short'}`}>
        <div className="db-stats">
          <Stat
            icon={Renew}
            more={
              <>
                <Row label="Joined" value={monthFormat.format(new Date(statistics.memberSince))} />
                {membership && (
                  <Row
                    label={`${ROLE_LABEL[membership.membership]} since`}
                    value={monthFormat.format(new Date(membership.since))}
                  />
                )}
              </>
            }
          >
            <span className="db-stat__value">{memberFor(statistics.memberSince, now)}</span>
            <span className="db-stat__label">Member</span>
          </Stat>
          <Stat
            icon={UserMultiple}
            more={
              <>
                <Row label="Hours in total" value={`${numberFormat.format(staffedHours)} h`} />
                <Row
                  label="Last time"
                  value={statistics.lastStaffedAt ? dayFormat.format(new Date(statistics.lastStaffedAt)) : 'Not yet'}
                />
              </>
            }
          >
            <div className="db-duo">
              <div>
                <span className="db-stat__value">{statistics.openDaysStaffed}</span>
                <span className="db-stat__label">Open days</span>
                <span className="db-stat__detail">{numberFormat.format(statistics.openDayHours)} hours staffed</span>
              </div>
              <div>
                <span className="db-stat__value">{statistics.eventShifts}</span>
                <span className="db-stat__label">Event shifts</span>
                <span className="db-stat__detail">{numberFormat.format(statistics.eventShiftHours)} hours helping</span>
              </div>
            </div>
          </Stat>
          {jobs && (
            <Stat
              icon={Chip}
              more={
                jobs.machines.length > 0 &&
                jobs.machines.map((machine) => (
                  <Row key={machine.name} label={machine.name} value={hours(machine.machineSeconds)} />
                ))
              }
            >
              <span className="db-stat__value">{hours(jobs.machineSeconds)}</span>
              <span className="db-stat__label">Machine time</span>
              {jobs.machines.length === 0 && <span className="db-stat__detail">No machine time yet</span>}
            </Stat>
          )}
          {jobs && (
            <Stat
              icon={Document}
              more={
                <>
                  {jobs.finishedJobs > 0 && (
                    <span
                      className="db-split"
                      role="img"
                      aria-label={`${jobs.successfulJobs} of ${plural(jobs.finishedJobs, 'finished job')} came out right`}
                    >
                      <i style={{ inlineSize: `${(jobs.successfulJobs / jobs.finishedJobs) * 100}%` }} />
                    </span>
                  )}
                  <Row label="Came out right" value={jobs.successfulJobs} />
                  <Row label="Failed" value={jobs.failedJobs} />
                  <Row label="This month" value={thisMonth} />
                </>
              }
            >
              <span className="db-stat__value">{jobs.jobs}</span>
              <span className="db-stat__label">Jobs</span>
              {jobs.jobs === 0 && <span className="db-stat__detail">Your first job is waiting</span>}
            </Stat>
          )}
        </div>
        {jobs && (
          <Stat icon={Tools} className="db-stat--material">
            <span className="db-stat__label">Material used</span>
            {jobs.materials.length > 0 ? (
              <ol className="db-rank">
                {jobs.materials.map((material, index) => (
                  <li key={material.name}>
                    <span className="db-rank__n">{index + 1}</span>
                    <span className="db-rank__name">{material.name}</span>
                    <span className="db-rank__bar" aria-hidden>
                      <i style={{ inlineSize: `${(material.jobs / topJobs) * 100}%` }} />
                    </span>
                    <span className="db-rank__value">{materialAmount(material.amount, material.dimension)}</span>
                    <span className="db-rank__jobs">{plural(material.jobs, 'job')}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <span className="db-stat__detail">No material recorded on your jobs yet.</span>
            )}
            <span className="db-stat__detail">{materialFun(jobs.materialGrams, area)}</span>
          </Stat>
        )}
      </div>
    </section>
  );
}
