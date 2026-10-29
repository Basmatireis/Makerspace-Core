import { Button, InlineNotification, ProgressIndicator, ProgressStep, Stack, Tag, TextArea, Tile } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import type {
  PrivacyCategory,
  SubjectRequest,
  SubjectRequestAssessment,
  SubjectRequestTransitionInputStatus,
} from '../../api/generated/models';
import {
  downloadSubjectRequestExport,
  executeSubjectRequest,
  transitionSubjectRequest,
} from '../../api/generated/privacy/privacy';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { formatDate } from '../../app/dateTime';
import { ErrorState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { useNow } from '../../app/useNow';
import { useCurrentUser } from '../auth/auth';
import { hasPermission } from '../auth/permissions';
import { saveBlob } from '../configtransfer/helpers';
import { SettingsLoading } from '../settings/SettingsPageLayout';
import {
  errorCode,
  privacyCategoriesQueryOptions,
  privacyErrorMessage,
  privacyQueryKey,
  subjectRequestQueryOptions,
} from './privacy';
import { privacyPath, privacySections, requestIdFromPath } from './privacyNavigation';
import {
  channelPhrases,
  dueInfo,
  isClosed,
  kindLabels,
  nextStep,
  outcomeWords,
  personLabel,
  rejectableStatuses,
  requestProgress,
  type Actor,
} from './privacyRequests';
import { RequestAssessment } from './RequestAssessment';
import { RequestExplanation, RequestFacts, RequestTimeline } from './RequestSidebar';
import './privacyRequests.scss';

const breadcrumbs = [
  { label: 'Settings', to: '/settings' },
  { label: 'Data', to: '/settings#data' },
  { label: privacySections.categories.title, to: privacyPath('categories') },
  { label: privacySections.requests.title, to: privacyPath('requests') },
];

const executedStatuses: readonly SubjectRequest['status'][] = ['executing', 'completed', 'partially_completed'];

function stepLabel(request: SubjectRequest, index: number, actor: Actor): string {
  const { done } = requestProgress(request);
  const status = [
    ['received'],
    ['identity_verified'],
    ['assessed'],
    ['approved'],
    executedStatuses as SubjectRequest['status'][],
  ][index];
  if (index < done) {
    const step = request.steps.filter((entry) => status.includes(entry.status)).at(-1);
    if (!step) return '';
    // Name and date only; the note stays in the timeline, where there is room for it.
    return [step.actorName, formatDate(step.occurredAt)].filter(Boolean).join(' · ');
  }
  if (index === done && !isClosed(request)) {
    const next = nextStep(request, actor);
    return next.mine ? 'Your move' : next.who;
  }
  return index === 4 ? (request.kind === 'erasure' ? 'deletes the person' : 'builds the export') : '';
}

function Progress({ request, actor }: { request: SubjectRequest; actor: Actor }) {
  const { done, stopped } = requestProgress(request);
  const names = [
    'Received',
    'Identity verified',
    'Assessed',
    done >= 4 ? 'Approved' : 'Approve',
    done >= 5 ? 'Executed' : 'Execute',
  ];
  return (
    <Tile className="privacy-request__steps">
      <ProgressIndicator currentIndex={done} spaceEqually>
        {names.map((label, index) => (
          <ProgressStep
            key={label}
            label={label}
            secondaryLabel={stepLabel(request, index, actor)}
            invalid={stopped && index === done}
          />
        ))}
      </ProgressIndicator>
    </Tile>
  );
}

type Dialog = 'execute' | 'reject';

function RequestView({
  request,
  actor,
  categories,
}: {
  request: SubjectRequest;
  actor: Actor;
  categories: readonly PrivacyCategory[] | undefined;
}) {
  const client = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>();
  const [note, setNote] = useState('');
  const [noteError, setNoteError] = useState(false);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState(false);
  const erasure = request.kind === 'erasure';
  const status = request.status;

  const settle = async () => {
    await client.invalidateQueries({ queryKey: privacyQueryKey });
  };
  const transition = useMutation({
    mutationFn: (input: { status: SubjectRequestTransitionInputStatus; note?: string }) =>
      transitionSubjectRequest(request.id, {
        status: input.status,
        ...(input.note ? { note: input.note } : {}),
        expectedVersion: request.version,
      }),
    onSuccess: async () => {
      setDialog(undefined);
      setNote('');
      await settle();
    },
    onError: () => void settle(),
  });
  const execute = useMutation({
    mutationFn: () => executeSubjectRequest(request.id, { expectedVersion: request.version }),
    onSuccess: async () => {
      setDialog(undefined);
      await settle();
    },
    onError: () => void settle(),
  });
  const download = useMutation({
    // Through the API client, so an expired fresh sign-in opens the re-authentication dialog instead of a JSON page.
    mutationFn: () => downloadSubjectRequestExport(request.id),
    onSuccess: (blob) => saveBlob(blob, `subject-request-${request.id}.zip`),
  });

  const error = transition.isError
    ? transition.error
    : execute.isError
      ? execute.error
      : download.isError
        ? download.error
        : undefined;
  const busy = transition.isPending || execute.isPending;
  const move = (next: SubjectRequestTransitionInputStatus, text?: string) => {
    execute.reset();
    download.reset();
    transition.mutate({ status: next, ...(text ? { note: text } : {}) });
  };
  const open = (next: Dialog) => {
    transition.reset();
    execute.reset();
    setReasonError(false);
    setDialog(next);
  };

  const verifier = request.identityVerifiedBy;
  const youVerified = verifier !== null && verifier === actor.accountId;
  const verifierName = request.identityVerifiedByName ?? 'The person who verified the identity';
  const canDownload =
    actor.canExecute &&
    request.kind === 'access' &&
    (status === 'completed' || status === 'partially_completed') &&
    request.exportAvailable;

  const stepCard = (title: string, lead: string, tone: '' | 'done' | 'stopped', children?: ReactNode) => (
    <Tile
      className={`privacy-request__card privacy-request__card--step${tone ? ` privacy-request__card--${tone}` : ''}`}
    >
      <div>
        <h2 className="cds--type-productive-heading-03">{title}</h2>
        <p className="privacy-request__lead">{lead}</p>
      </div>
      {children}
    </Tile>
  );
  const noteField = (id: string, label: string, placeholder: string, required: boolean) => (
    <div className="privacy-request__field">
      <TextArea
        id={id}
        labelText={label}
        placeholder={placeholder}
        maxLength={1000}
        rows={3}
        value={note}
        invalid={required && noteError}
        invalidText="This field is required."
        onChange={(event) => {
          setNote(event.target.value);
          setNoteError(false);
        }}
      />
    </div>
  );

  let current: ReactNode;
  switch (status) {
    case 'received':
      current = stepCard(
        'Step 2 · Verify the identity',
        'Check that the person asking is the person whose data it is. Record how you checked, never what you copied.',
        '',
        <>
          {noteField('request-note', 'How did you verify? e.g. student card shown in person', '', true)}
          <div className="privacy-request__actions">
            <Button
              kind="primary"
              disabled={busy}
              onClick={() => (note.trim() === '' ? setNoteError(true) : move('identity_verified', note.trim()))}
            >
              Mark identity as verified
            </Button>
          </div>
        </>,
      );
      break;
    case 'identity_verified':
      current = stepCard(
        'Step 3 · Run the assessment',
        `The assessment counts what we hold about the person and what the ${erasure ? 'erasure' : 'export'} would do. It is a dry run; nothing is changed.`,
        '',
        <div className="privacy-request__actions">
          <Button kind="primary" disabled={busy} onClick={() => move('assessed')}>
            Run the assessment
          </Button>
        </div>,
      );
      break;
    case 'assessed':
      current = stepCard(
        erasure ? 'Step 4 · Approve the erasure' : 'Step 4 · Approve the access',
        erasure
          ? 'Check the assessment below. Approving does not delete anything yet; the deletion happens in step 5 and can still be stopped until then.'
          : 'Check the assessment below. Approving does not build anything yet; the export is built in step 5.',
        '',
        <>
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Four eyes"
            subtitle={
              youVerified
                ? 'You verified the identity, so someone else must approve. A master may do both.'
                : `${verifierName} verified the identity, so someone else must approve. You can. A master may do both.`
            }
          />
          {noteField(
            'request-note',
            'Note for the file (optional)',
            'e.g. “no open invoices, checked with the treasurer”',
            false,
          )}
          <div className="privacy-request__actions">
            <Button kind="tertiary" disabled={busy} onClick={() => move('assessed')}>
              Run the assessment again
            </Button>
            <Button kind="primary" disabled={busy} onClick={() => move('approved', note.trim())}>
              {erasure ? 'Approve the erasure' : 'Approve the access'}
            </Button>
          </div>
        </>,
      );
      break;
    case 'approved':
      current = stepCard(
        erasure ? "Step 5 · Delete the person's data" : 'Step 5 · Build the export',
        erasure
          ? 'This step cannot be undone. Everything the assessment marks as deleted is removed in one go.'
          : 'Builds a ZIP with everything we hold about the person, as listed in the assessment. Hand it only to the person who asked.',
        '',
        actor.canExecute ? (
          <div className="privacy-request__actions">
            {erasure ? (
              <Button kind="danger" disabled={busy} onClick={() => open('execute')}>
                Delete the person&apos;s data
              </Button>
            ) : (
              <Button kind="primary" disabled={busy} onClick={() => execute.mutate()}>
                {execute.isPending ? 'Building…' : 'Build the export'}
              </Button>
            )}
          </div>
        ) : (
          <InlineNotification
            kind="info"
            lowContrast
            hideCloseButton
            title="Someone else's move"
            subtitle="Only people with the execute permission can take this step."
          />
        ),
      );
      break;
    case 'executing':
      current = stepCard('Step 5 · Executing', 'The execution is running. Reload in a moment to see its result.', '');
      break;
    case 'rejected':
      current = stepCard(
        'Rejected',
        request.rejectionReason
          ? `This request was rejected: ${request.rejectionReason}`
          : 'This request was rejected.',
        'stopped',
      );
      break;
    default:
      current = stepCard(
        status === 'completed' ? 'Completed' : 'Completed in part',
        erasure
          ? 'The erasure was executed. What it did, category by category, is listed below.'
          : 'The export was built. What it contains is listed below.',
        'done',
        canDownload ? (
          <div className="privacy-request__actions">
            <Button kind="primary" disabled={download.isPending} onClick={() => download.mutate()}>
              {download.isPending ? 'Downloading…' : 'Download export'}
            </Button>
          </div>
        ) : undefined,
      );
  }

  const assessment: SubjectRequestAssessment | null = request.assessment;
  const result: SubjectRequestAssessment | null = request.result;
  const dialogError = dialog && error ? privacyErrorMessage(error) : undefined;
  const planned = assessment?.categories ?? [];
  const lines = (outcome: 'erased' | 'unlinked' | 'retained_legal') =>
    planned.filter((category) => category.outcome === outcome).map((category) => category.name);

  return (
    <div className="privacy-request">
      <Progress request={request} actor={actor} />
      <div className="privacy-request__columns">
        <div className="privacy-request__main">
          {error && !dialog && (
            <InlineNotification
              kind={errorCode(error) === 'stale_write' ? 'warning' : 'error'}
              lowContrast
              hideCloseButton
              title={errorCode(error) ?? 'Action failed'}
              subtitle={privacyErrorMessage(error)}
            />
          )}
          {current}
          {result ? (
            <RequestAssessment
              request={request}
              assessment={result}
              title={erasure ? 'What the erasure did' : 'What the export contains'}
              lead={
                request.executedAt
                  ? `Executed ${formatDate(request.executedAt)}${request.executedByName ? ` by ${request.executedByName}` : ''}.`
                  : 'The result of the execution.'
              }
              categories={categories}
            />
          ) : (
            assessment && (
              <RequestAssessment
                request={request}
                assessment={assessment}
                title={
                  erasure ? 'What we hold, and what the erasure does' : 'What we hold, and what the export contains'
                }
                lead={`Assessed ${request.assessedAt ? formatDate(request.assessedAt) : ''}. The numbers come from a dry run; nothing was changed.`}
                categories={categories}
              />
            )
          )}
          {rejectableStatuses.includes(status) && (
            <div className="privacy-request__reject">
              <Button kind="danger--ghost" disabled={busy} onClick={() => open('reject')}>
                Reject this request…
              </Button>
              <span className="cds--type-helper-text-01">Rejecting needs a reason; it stays in the file.</span>
            </div>
          )}
        </div>
        <div className="privacy-request__side">
          <RequestFacts request={request} />
          <RequestTimeline request={request} />
          <RequestExplanation request={request} />
        </div>
      </div>
      <DestructiveActionDialog
        open={dialog === 'reject'}
        title="Reject this request"
        confirmLabel="Reject"
        pending={transition.isPending}
        error={dialogError}
        onClose={() => setDialog(undefined)}
        onConfirm={() => (reason.trim() === '' ? setReasonError(true) : move('rejected', reason.trim()))}
      >
        <TextArea
          id="request-reject-reason"
          labelText="Reason"
          maxLength={1000}
          rows={3}
          value={reason}
          invalid={reasonError}
          invalidText="This field is required."
          onChange={(event) => {
            setReason(event.target.value);
            setReasonError(false);
          }}
        />
      </DestructiveActionDialog>
      <DestructiveActionDialog
        open={dialog === 'execute'}
        title="Delete the person's data"
        confirmLabel="Delete the data"
        pending={execute.isPending}
        error={dialogError}
        onClose={() => setDialog(undefined)}
        onConfirm={() => execute.mutate()}
      >
        <Stack gap={4}>
          <p>This deletes {personLabel(request)} and cannot be undone.</p>
          <ul>
            {lines('erased').length > 0 && (
              <li>
                {outcomeWords.erased}: {lines('erased').join(', ')}.
              </li>
            )}
            {lines('unlinked').length > 0 && (
              <li>
                {outcomeWords.unlinked}: {lines('unlinked').join(', ')}.
              </li>
            )}
            {lines('retained_legal').length > 0 && (
              <li>
                {outcomeWords.retained_legal}: {lines('retained_legal').join(', ')}.
              </li>
            )}
          </ul>
          <p>Backups still hold the data until they rotate.</p>
        </Stack>
      </DestructiveActionDialog>
    </div>
  );
}

/** One data request: the five steps, the one to take now, and what the assessment found. */
export function SubjectRequestPage() {
  const currentUser = useCurrentUser();
  const location = useLocation();
  const requestId = requestIdFromPath(location.pathname);
  const request = useQuery({ ...subjectRequestQueryOptions(requestId ?? ''), enabled: requestId !== null });
  // The categories only add the "what it contains" lines; someone without the privacy.read permission goes without.
  const categories = useQuery({
    ...privacyCategoriesQueryOptions(),
    enabled: hasPermission(currentUser, 'privacy.read'),
  });
  const now = useNow();
  if (requestId === null) return <Navigate to={privacyPath('requests')} replace />;
  if (request.isPending) {
    return (
      <PageShell title="Data request" breadcrumbs={breadcrumbs} width="wide">
        <SettingsLoading label="Loading the request" />
      </PageShell>
    );
  }
  if (request.isError) {
    return (
      <PageShell title="Data request" breadcrumbs={breadcrumbs} width="wide">
        <ErrorState message={request.error.message} onRetry={() => void request.refetch()} />
      </PageShell>
    );
  }
  const data = request.data;
  const actor: Actor = {
    accountId: currentUser.account.id,
    canManage: hasPermission(currentUser, 'privacy.requests.manage'),
    canExecute: hasPermission(currentUser, 'privacy.requests.execute'),
  };
  const due = dueInfo(data, now);
  const erasure = data.kind === 'erasure';
  const received = `received ${channelPhrases[data.channel]} on ${formatDate(data.receivedAt)}`;
  return (
    <PageShell
      title={`${personLabel(data)} asks for ${erasure ? 'erasure' : 'a copy of their data'}`}
      titleAdornment={
        <Tag type={erasure ? 'blue' : 'purple'} size="md">
          {kindLabels[data.kind]}
        </Tag>
      }
      description={data.reference ? `${data.reference} · ${received}` : received[0].toUpperCase() + received.slice(1)}
      breadcrumbs={breadcrumbs}
      width="wide"
      actions={
        <div className="privacy-due">
          <span className="privacy-due__label">{isClosed(data) ? 'Was due' : 'Due'}</span>
          <span className={`privacy-due__value${due.late ? ' privacy-due__value--late' : ''}`}>
            {formatDate(data.dueAt)} · {due.text}
          </span>
        </div>
      }
    >
      <RequestView request={data} actor={actor} categories={categories.data?.categories} />
    </PageShell>
  );
}
