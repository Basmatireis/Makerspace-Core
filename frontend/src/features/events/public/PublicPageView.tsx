import '../public.scss';
import { Download } from '@carbon/icons-react';
import { Button, InlineNotification, Link as CarbonLink, Tag, Tile } from '@carbon/react';
import type { EventSignup, PublicEvent, PublicEventRequirement, PublicEventShift } from '../../../api/generated/models';
import { SummaryStrip } from '../components/Layout';
import { dayKey, fmtDay, fmtRange, formatLocalDate } from '../format';
import { availabilityOf, programme } from '../logic';

const formatSize = (bytes: number) =>
  bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} kB`;

/**
 * What visitors see. Used by the public route and by the live preview in the Public page tab, so the preview is the
 * real page; internal fields never reach this component because it only takes the public event.
 */
export function PublicPageView({
  event,
  mode,
  signedIn,
  bannerUrl,
  own = [],
  onSignup,
  onMove,
  onCancel,
  onDownload,
}: {
  event: PublicEvent;
  mode: 'live' | 'preview';
  signedIn: boolean;
  bannerUrl?: string | null;
  own?: EventSignup[];
  onSignup?: (shift: PublicEventShift, requirement: PublicEventRequirement) => void;
  onMove?: (assignment: EventSignup) => void;
  onCancel?: (assignment: EventSignup) => void;
  onDownload?: (file: PublicEvent['files'][number]) => void;
}) {
  const preview = mode === 'preview';
  const closed = event.status === 'completed' || event.status === 'cancelled';
  const days = programme(event.sessions, []);
  const items = [...event.sessions, ...event.shifts].map((item) => item);
  const start = items.map((item) => item.startsAt).sort()[0];
  const end = items
    .map((item) => item.endsAt)
    .sort()
    .at(-1);
  const title = event.title.trim();
  const active = own.filter((assignment) => assignment.status === 'active');
  const shiftOf = (id: string) => event.shifts.find((shift) => shift.id === id);
  const idp = `ev-${mode}`;

  return (
    <article className="ev-public">
      {event.hasBanner && bannerUrl && <img className="ev-public__banner" src={bannerUrl} alt="" />}
      <div className="ev-public__body">
        <header className="ev-public__head">
          {title ? <h1>{title}</h1> : <h1 className="ev-public__placeholder">No public title yet</h1>}
          <SummaryStrip
            label="Event details"
            items={[
              {
                label: 'Date',
                value:
                  start && end
                    ? dayKey(start) === dayKey(end)
                      ? formatLocalDate(start)
                      : `${fmtDay(start)} – ${fmtDay(end)}`
                    : 'To be announced',
              },
              { label: 'Location', value: event.location?.trim() || 'To be announced' },
            ]}
          />
        </header>
        {closed && (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title={event.status === 'cancelled' ? 'This event was cancelled.' : 'This event has taken place.'}
            subtitle="Helper signup is closed."
          />
        )}
        {event.description?.trim() && <p className="ev-public__text">{event.description.trim()}</p>}

        {active.length > 0 && (
          <section aria-labelledby={`${idp}-mine`}>
            <h2 id={`${idp}-mine`}>Your signups</h2>
            <div className="ev-public__list">
              {active.map((assignment) => {
                const shift = shiftOf(assignment.shiftId);
                const position = shift?.requirements.find((item) => item.id === assignment.requirementId);
                return (
                  <Tile key={assignment.id} className="ev-public__row">
                    <div>
                      <strong>{shift?.name ?? 'Shift'}</strong> · {position?.name}
                      <br />
                      <span className="ev-secondary">
                        {shift && `${fmtDay(shift.startsAt)}, ${fmtRange(shift.startsAt, shift.endsAt)}`}
                      </span>
                    </div>
                    <div className="ev-inline">
                      <Button
                        kind="tertiary"
                        size="sm"
                        disabled={preview || closed}
                        onClick={() => onMove?.(assignment)}
                      >
                        Move
                      </Button>
                      <Button
                        kind="danger--tertiary"
                        size="sm"
                        disabled={preview || closed}
                        onClick={() => onCancel?.(assignment)}
                      >
                        Cancel signup
                      </Button>
                    </div>
                  </Tile>
                );
              })}
            </div>
          </section>
        )}

        {days.length > 0 && (
          <section aria-labelledby={`${idp}-programme`}>
            <h2 id={`${idp}-programme`}>Programme</h2>
            {days.map((day) => (
              <div key={day.key} className="ev-public__day">
                <h3>{fmtDay(day.date)}</h3>
                {day.sessions.map(({ session }) => (
                  <div key={session.id} className="ev-public__session">
                    <span className="ev-public__time">{fmtRange(session.startsAt, session.endsAt)}</span>
                    <div>
                      <strong>{session.name || 'Session'}</strong>
                      {session.location && <div className="ev-secondary">{session.location}</div>}
                      {session.description && <div>{session.description}</div>}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </section>
        )}

        {event.shifts.length > 0 && (
          <section aria-labelledby={`${idp}-help`}>
            <h2 id={`${idp}-help`}>Help us</h2>
            {!event.publicSignupEnabled && !closed && (
              <p className="ev-secondary">Helper signup is not open at the moment.</p>
            )}
            <div className="ev-public__list">
              {event.shifts.map((shift) => (
                <Tile key={shift.id} className="ev-public__shift">
                  <div>
                    <strong>{shift.name}</strong>
                    <div className="ev-secondary">
                      {fmtDay(shift.startsAt)}, {fmtRange(shift.startsAt, shift.endsAt)}
                    </div>
                    {shift.description && <div>{shift.description}</div>}
                  </div>
                  {shift.requirements.length === 0 && <p className="ev-secondary">No places yet.</p>}
                  {shift.requirements.map((requirement) => {
                    const info = availabilityOf(requirement, signedIn, event.publicSignupEnabled);
                    return (
                      <div key={requirement.id} className="ev-public__position">
                        <div>
                          <span>{requirement.name}</span>{' '}
                          <span className="ev-secondary">
                            {requirement.filledCount} of {requirement.requiredCount} filled
                          </span>
                          {requirement.description && <div className="ev-secondary">{requirement.description}</div>}
                          {info.note && <div className="ev-secondary">{info.note}</div>}
                        </div>
                        <div className="ev-inline">
                          <Tag type={info.type} size="sm">
                            {info.label}
                          </Tag>
                          {info.canSignUp && (
                            <Button
                              size="sm"
                              disabled={preview}
                              title={preview ? 'Preview only' : undefined}
                              onClick={() => onSignup?.(shift, requirement)}
                            >
                              Sign up
                            </Button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </Tile>
              ))}
            </div>
          </section>
        )}

        {event.files.length > 0 && (
          <section aria-labelledby={`${idp}-downloads`}>
            <h2 id={`${idp}-downloads`}>Downloads</h2>
            <ul className="ev-public__downloads">
              {event.files.map((file) => (
                <li key={file.id}>
                  {preview ? (
                    <span>{file.originalFilename}</span>
                  ) : (
                    <CarbonLink
                      href="#"
                      renderIcon={Download}
                      onClick={(e: React.MouseEvent) => {
                        e.preventDefault();
                        onDownload?.(file);
                      }}
                    >
                      {file.originalFilename}
                    </CarbonLink>
                  )}{' '}
                  <span className="ev-secondary">{formatSize(file.sizeBytes)}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </article>
  );
}
