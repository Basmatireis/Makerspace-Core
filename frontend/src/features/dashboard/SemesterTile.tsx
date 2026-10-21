import { Button, ProgressBar, Tile } from '@carbon/react';
import { ArrowRight, CheckmarkFilled, Partnership, WarningAltFilled } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import type { PersonalDashboardStaffing } from '../../api/generated/models';
import { plural, shortDate } from './format';

/** Progress towards the semester's open-day minimum (supervisors) or towards promotion (trainees). */
export function SemesterTile({
  staffing,
  canFindOpenDays,
}: {
  staffing: PersonalDashboardStaffing;
  canFindOpenDays: boolean;
}) {
  const { semester, status } = staffing;
  const trainee = staffing.kind === 'trainee';
  // Supervisors: signed-up open days towards the minimum (signing up is enough). Trainees: open days staffed as
  // trainee towards promotion.
  const value = trainee ? staffing.staffedAsTrainee : staffing.staffed + staffing.booked;
  const target = trainee ? staffing.traineeThreshold : staffing.minimum;
  const heading = `${trainee ? 'Trainee' : 'This semester'}${semester ? ` · ${semester.name}` : ''}`;

  return (
    <Tile className="db-tile">
      <span className="db-tile__eyebrow">
        <Partnership size={16} aria-hidden />
        {heading}
      </span>
      {semester === null ? (
        <p className="db-tile__meta">No open-day period is scheduled right now.</p>
      ) : (
        <>
          <p className="db-value">
            {value} <span className="db-value__of">of {target}</span>
          </p>
          <ProgressBar
            label={trainee ? 'Open days as trainee' : 'Open days signed up this semester'}
            hideLabel
            size="small"
            value={Math.min(value, target)}
            max={Math.max(target, 1)}
            status={value >= target ? 'finished' : 'active'}
          />
          <p className="db-tile__meta">
            {trainee ? 'open days as trainee' : 'open days signed up'} · {staffing.staffed} staffed, {staffing.booked}{' '}
            booked
          </p>
          {status === 'ready' && (
            <p className="db-status db-status--ok">
              <CheckmarkFilled size={16} aria-hidden />
              You can become a supervisor now. The Leitung takes care of it.
            </p>
          )}
          {status === 'fulfilled' &&
            (trainee ? (
              <p className="db-tile__meta">
                After {plural(target, 'open day')} as trainee the Leitung makes you a supervisor. Your semester minimum
                is covered.
              </p>
            ) : (
              <p className="db-status db-status--ok">
                <CheckmarkFilled size={16} aria-hidden />
                Signed up for the minimum of {plural(staffing.minimum, 'open day')}. Thanks!
              </p>
            ))}
          {status === 'missing' && (
            <p className="db-status db-status--warning">
              <WarningAltFilled size={16} aria-hidden />
              Sign up for {plural(staffing.missing, 'open day')} more by {shortDate(semester.endsOn)} to keep your room
              access.
            </p>
          )}
        </>
      )}
      {canFindOpenDays && (
        <div className="db-tile__actions">
          <Button as={Link} to="/open-days" kind="ghost" size="sm" renderIcon={ArrowRight}>
            Find open days
          </Button>
        </div>
      )}
    </Tile>
  );
}
