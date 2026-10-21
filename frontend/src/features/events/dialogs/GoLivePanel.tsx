import { CheckmarkFilled, CloseOutline, Launch, Restart } from '@carbon/icons-react';
import {
  Button,
  CopyButton,
  InlineNotification,
  Link as CarbonLink,
  Modal,
  Stack,
  StructuredListBody,
  StructuredListCell,
  StructuredListRow,
  StructuredListWrapper,
  TextInput,
  Toggle,
} from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { publishEvent, unpublishEvent, updateEvent } from '../../../api/generated/events/events';
import type { Event, EventShift } from '../../../api/generated/models';
import { ShiftStatusTag, VisibilityTag } from '../components/StatusTags';
import { eventMutationMessage } from '../errors';
import { checklist, isClosed, PAGE_REQUIREMENTS, SIGNUP_REQUIREMENTS, type Check, type FixTarget } from '../logic';
import { plural } from '../format';
import { invalidateEvents } from '../queries';
import { eventBody } from '../requestBodies';

export const publicLink = (publicId: string) => `${window.location.origin}/events/public/${publicId}`;

function Checklist({ label, checks, onFix }: { label: string; checks: Check[]; onFix: (target: FixTarget) => void }) {
  return (
    <StructuredListWrapper isFlush isCondensed aria-label={label}>
      <StructuredListBody>
        {checks.map((check) => (
          <StructuredListRow key={check.code}>
            <StructuredListCell className={`evf-check__icon ${check.ok ? 'evf-check--ok' : 'evf-check--todo'}`}>
              {check.ok ? (
                <CheckmarkFilled size={16} aria-label="Done" />
              ) : (
                <CloseOutline size={16} aria-label="Missing" />
              )}
            </StructuredListCell>
            <StructuredListCell>{check.label}</StructuredListCell>
            <StructuredListCell className="evf-check__fix">
              {!check.ok && check.fix && check.fix !== 'page' && check.fix !== 'signup' && (
                <CarbonLink
                  href="#"
                  onClick={(e: React.MouseEvent) => {
                    e.preventDefault();
                    onFix(check.fix);
                  }}
                >
                  Fix
                </CarbonLink>
              )}
              {!check.ok && check.fix === 'page' && <span className="ev-secondary">Switch it on above</span>}
            </StructuredListCell>
          </StructuredListRow>
        ))}
      </StructuredListBody>
    </StructuredListWrapper>
  );
}

/**
 * One place that answers "can helpers sign up right now, and if not, why?". The checklists come from the server's
 * `goLive`; this panel only words them. A side panel on wide screens, a modal on narrow ones (CSS).
 */
export function GoLivePanel({
  event,
  shifts,
  onClose,
  onFix,
  onRotate,
}: {
  event: Event;
  shifts: EventShift[];
  onClose: () => void;
  onFix: (target: FixTarget) => void;
  onRotate: () => void;
}) {
  const client = useQueryClient();
  const live = event.goLive.publicPage.state === 'live';
  const signupOn = event.publicSignupEnabled;
  const publish = useMutation({
    mutationFn: (on: boolean) =>
      on
        ? publishEvent(event.id, { expectedVersion: event.version })
        : unpublishEvent(event.id, { expectedVersion: event.version }),
    onSuccess: () => invalidateEvents(client),
  });
  const signup = useMutation({
    mutationFn: (on: boolean) => updateEvent(event.id, eventBody(event, { publicSignupEnabled: on })),
    onSuccess: () => invalidateEvents(client),
  });
  const pageUnmet = event.goLive.publicPage.unmet;
  const signupUnmet = event.goLive.helperSignup.unmet;
  const closed = isClosed(event.status);
  const pageChecks = checklist(closed ? ['event_closed', ...PAGE_REQUIREMENTS] : PAGE_REQUIREMENTS, pageUnmet);
  const signupChecks = checklist(
    closed ? ['event_closed', ...SIGNUP_REQUIREMENTS] : SIGNUP_REQUIREMENTS,
    signupUnmet.filter((code) => code !== 'signup_disabled'),
  );
  const pageBlocked = !live && pageUnmet.length > 0;
  const signupBlocked = !signupOn && signupChecks.some((check) => !check.ok);
  const summary = event.goLive.shifts;
  const url = publicLink(event.publicId);
  const liveShifts = shifts.filter((shift) => shift.status !== 'cancelled');
  const error = publish.error ?? signup.error;

  return (
    <Modal
      open
      passiveModal
      className="ev-sidepanel"
      size="md"
      modalHeading="Go live"
      modalLabel={event.name}
      onRequestClose={onClose}
    >
      <Stack gap={7}>
        {error && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Change not saved"
            subtitle={eventMutationMessage(error)}
          />
        )}
        <section className="evf-block" aria-labelledby="ev-live-page">
          <h3 id="ev-live-page" className="evf-block__title">
            Public page
          </h3>
          <Toggle
            id="ev-live-page-toggle"
            size="sm"
            labelText="Public page"
            hideLabel
            labelA="Off"
            labelB="Live"
            toggled={live}
            disabled={pageBlocked || publish.isPending}
            onToggle={(on) => publish.mutate(on)}
          />
          <p className="ev-secondary">
            Visitors can open the public link and see the programme, files and helper shifts marked public.
          </p>
          {!live && <Checklist label="Requirements for the public page" checks={pageChecks} onFix={onFix} />}
          {pageBlocked && <p className="ev-secondary">The switch stays off until every item is done.</p>}
          {live && closed && (
            <p className="ev-secondary">
              The event is {event.status}; the page stays reachable as information until you switch it off.
            </p>
          )}
        </section>

        <section className="evf-block" aria-labelledby="ev-live-signup">
          <h3 id="ev-live-signup" className="evf-block__title">
            Helper signup
          </h3>
          <Toggle
            id="ev-live-signup-toggle"
            size="sm"
            labelText="Helper signup"
            hideLabel
            labelA="Off"
            labelB="Open"
            toggled={signupOn}
            disabled={signupBlocked || signup.isPending}
            onToggle={(on) => signup.mutate(on)}
          />
          <p className="ev-secondary">Visitors can sign up to open, public shifts on the public page.</p>
          {!signupOn && <Checklist label="Requirements for helper signup" checks={signupChecks} onFix={onFix} />}
          {signupBlocked && <p className="ev-secondary">The switch stays off until every item is done.</p>}
        </section>

        <section className="evf-block" aria-labelledby="ev-live-shifts">
          <h3 id="ev-live-shifts" className="evf-block__title">
            Shifts accepting signups
          </h3>
          <p className="ev-secondary">
            {summary.accepting} of {plural(summary.total, 'shift')} accept signups
            {summary.notPublic > 0 && ` · ${summary.notPublic} not public`}
          </p>
          {liveShifts.length > 0 && (
            <StructuredListWrapper isFlush isCondensed aria-label="Shifts and their signup state">
              <StructuredListBody>
                {liveShifts.map((shift) => (
                  <StructuredListRow key={shift.id}>
                    <StructuredListCell>{shift.name}</StructuredListCell>
                    <StructuredListCell className="evf-check__fix">
                      <span className="ev-inline">
                        <ShiftStatusTag status={shift.status} />
                        <VisibilityTag isPublic={shift.isPublic} />
                      </span>
                    </StructuredListCell>
                  </StructuredListRow>
                ))}
              </StructuredListBody>
            </StructuredListWrapper>
          )}
        </section>

        <section className="evf-block" aria-labelledby="ev-live-link">
          <h3 id="ev-live-link" className="evf-block__title">
            Public link
          </h3>
          <div className="evf-copy">
            <TextInput id="ev-live-url" readOnly labelText="Public link" hideLabel value={url} />
            <CopyButton
              align="top"
              feedback="Copied"
              iconDescription="Copy link"
              onClick={() => {
                void navigator.clipboard?.writeText(url);
              }}
            />
          </div>
          <div className="evf-actions">
            <Button kind="tertiary" size="sm" renderIcon={Launch} as="a" href={url} target="_blank" rel="noreferrer">
              Open
            </Button>
            {!closed && (
              <Button kind="ghost" size="sm" renderIcon={Restart} onClick={onRotate}>
                Rotate link
              </Button>
            )}
          </div>
          {!live && (
            <p className="ev-secondary">The link shows &ldquo;not available&rdquo; until the public page is live.</p>
          )}
        </section>
      </Stack>
    </Modal>
  );
}
