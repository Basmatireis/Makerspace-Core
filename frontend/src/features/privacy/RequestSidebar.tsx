import { CircleFilled } from '@carbon/icons-react';
import { InlineNotification, Link, Tile } from '@carbon/react';
import { Link as RouterLink } from 'react-router-dom';
import type { SubjectRequest } from '../../api/generated/models';
import { formatDate, formatDateTime } from '../../app/dateTime';
import { channelPhrases, closedAt, isClosed, personLabel, statusLabels } from './privacyRequests';
import './privacyRequests.scss';

const waitingFor: Partial<Record<SubjectRequest['status'], string>> = {
  received: 'Waiting for the identity check',
  identity_verified: 'Waiting for the assessment',
  assessed: 'Waiting for approval',
  approved: 'Waiting for the execution',
};

function stepSentence(step: SubjectRequest['steps'][number], request: SubjectRequest): string {
  const note = step.note ? `: ${step.note}` : '';
  switch (step.status) {
    case 'received':
      return `Recorded, received ${channelPhrases[request.channel]}${note}`;
    case 'rejected':
      return `Rejected${note}`;
    default:
      return `${statusLabels[step.status]}${note}`;
  }
}

/** Who and what the request is about: the facts that do not change while it moves. */
export function RequestFacts({ request }: { request: SubjectRequest }) {
  const erasure = request.kind === 'erasure';
  return (
    <Tile className="privacy-request__card">
      <h2 className="cds--type-productive-heading-03">The request</h2>
      <dl className="privacy-request__kv">
        <dt>Person</dt>
        <dd>
          {request.personId ? (
            <Link as={RouterLink} to={`/people/${request.personId}`}>
              {personLabel(request)}
            </Link>
          ) : (
            personLabel(request)
          )}
        </dd>
        <dt>Asks for</dt>
        <dd>{erasure ? 'Erasure of all data' : 'A copy of their data'}</dd>
        <dt>Reached us</dt>
        <dd>
          {channelPhrases[request.channel][0].toUpperCase() + channelPhrases[request.channel].slice(1)},{' '}
          {formatDate(request.receivedAt)}
        </dd>
        <dt>Due</dt>
        <dd>{formatDate(request.dueAt)} (one month)</dd>
        {request.reference && (
          <>
            <dt>Reference</dt>
            <dd>{request.reference}</dd>
          </>
        )}
        {request.notes && (
          <>
            <dt>Notes</dt>
            <dd>{request.notes}</dd>
          </>
        )}
      </dl>
    </Tile>
  );
}

/** The steps taken so far, newest first, with the one the request waits for on top. */
export function RequestTimeline({ request }: { request: SubjectRequest }) {
  const since = request.steps.at(-1)?.occurredAt ?? closedAt(request);
  const waiting = isClosed(request) ? undefined : waitingFor[request.status];
  return (
    <Tile className="privacy-request__card">
      <h2 className="cds--type-productive-heading-03">What happened so far</h2>
      <ol className="privacy-timeline">
        {waiting && (
          <li className="privacy-timeline__item">
            <CircleFilled size={12} className="privacy-timeline__dot privacy-timeline__dot--now" aria-hidden="true" />
            <div>
              <div>{waiting}</div>
              {since && <div className="cds--type-helper-text-01">since {formatDateTime(since)}</div>}
            </div>
          </li>
        )}
        {[...request.steps].reverse().map((step, index) => (
          <li key={`${step.status}-${step.occurredAt}-${index}`} className="privacy-timeline__item">
            <CircleFilled size={12} className="privacy-timeline__dot" aria-hidden="true" />
            <div>
              <div>{stepSentence(step, request)}</div>
              <div className="cds--type-helper-text-01">
                {step.actorName ?? 'System'} · {formatDateTime(step.occurredAt)}
              </div>
            </div>
          </li>
        ))}
      </ol>
    </Tile>
  );
}

/** What the last step does, so nobody approves without knowing. */
export function RequestExplanation({ request }: { request: SubjectRequest }) {
  const erasure = request.kind === 'erasure';
  const started = request.status === 'approved' || request.status === 'executing';
  return (
    <Tile className="privacy-request__card">
      <h2 className="cds--type-productive-heading-03">{started ? 'What execution does' : 'After approval'}</h2>
      <p className="cds--type-body-compact-01 privacy-requests__secondary">
        {erasure
          ? 'The last step deletes the person, the account and everything linked to them in one go, and keeps records the law requires without the name. If something stays, the request closes as “completed in part”, with a result you can show the person.'
          : 'The last step collects everything we hold about the person in a ZIP file. Building it changes no data. Hand the file only to the person who asked, after the identity is verified.'}
      </p>
      {erasure && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title="Backups"
          subtitle="Backups still hold the data until they rotate. Tell the person so when you confirm."
        />
      )}
    </Tile>
  );
}
