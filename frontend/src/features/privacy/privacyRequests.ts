import type {
  SubjectRequest,
  SubjectRequestAssessment,
  SubjectRequestChannel,
  SubjectRequestKind,
  SubjectRequestOutcome,
  SubjectRequestStatus,
} from '../../api/generated/models';
import { dateInAppTimeZone, formatDate } from '../../app/dateTime';

const DAY = 86_400_000;

export const kindLabels: Record<SubjectRequestKind, string> = { access: 'Access', erasure: 'Erasure' };

export const statusLabels: Record<SubjectRequestStatus, string> = {
  received: 'Received',
  identity_verified: 'Identity verified',
  assessed: 'Assessed',
  approved: 'Approved',
  executing: 'Executing',
  completed: 'Completed',
  partially_completed: 'Completed in part',
  rejected: 'Rejected',
};

export const channelLabels: Record<SubjectRequestChannel, string> = {
  email: 'Email',
  in_person: 'In person',
  letter: 'Letter',
  other: 'Other',
};

/** How the request reached us, as a phrase after "received". */
export const channelPhrases: Record<SubjectRequestChannel, string> = {
  email: 'by e-mail',
  in_person: 'in person',
  letter: 'by letter',
  other: 'through another channel',
};

export const outcomeWords: Record<SubjectRequestOutcome, string> = {
  erased: 'Deleted',
  unlinked: 'Kept without the name',
  retained_legal: 'Kept for a legal obligation',
  manual_review: 'Needs manual review',
};

export const blockerWords: Record<string, string> = {
  person_scim_managed: 'The person is provisioned by the identity provider; deprovision there first.',
  accounts_delete_required: 'Deleting the account needs the accounts.delete permission.',
  erasure_on_hold: 'A hold on this person blocks the erasure.',
};

export const closedStatuses: readonly SubjectRequestStatus[] = ['completed', 'partially_completed', 'rejected'];
export const rejectableStatuses: readonly SubjectRequestStatus[] = [
  'received',
  'identity_verified',
  'assessed',
  'approved',
];

export function isClosed(request: SubjectRequest): boolean {
  return closedStatuses.includes(request.status);
}

/** How many of the five steps are done: received, identity verified, assessed, approved, executed. */
function statusStep(status: SubjectRequestStatus): number {
  switch (status) {
    case 'received':
      return 1;
    case 'identity_verified':
      return 2;
    case 'assessed':
      return 3;
    case 'approved':
    case 'executing':
      return 4;
    default:
      return 5;
  }
}

export type Progress = { done: number; stopped: boolean };

/** Steps done, and whether the request ended early (rejected) at the step after them. */
export function requestProgress(request: SubjectRequest): Progress {
  if (request.status !== 'rejected') return { done: statusStep(request.status), stopped: false };
  const last = request.steps.filter((step) => step.status !== 'rejected').at(-1);
  return { done: last ? statusStep(last.status) : 1, stopped: true };
}

export function personLabel(request: SubjectRequest): string {
  return request.personName ?? 'Erased person';
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function totalRecords(assessment: SubjectRequestAssessment): number {
  return assessment.categories.reduce((sum, category) => sum + category.records, 0);
}

export type NextStep = { task: string; who: string; mine: boolean; fact: string };

export type Actor = { accountId: string; canManage: boolean; canExecute: boolean };

function assessmentFact(request: SubjectRequest): string {
  const assessment = request.assessment;
  if (!assessment) return '';
  const records = `${plural(totalRecords(assessment), 'record', 'records')} in ${plural(
    assessment.categories.length,
    'category',
    'categories',
  )}`;
  const blockers = assessment.blockers.length + assessment.openHolds;
  return blockers > 0 ? `${records}, ${plural(blockers, 'blocker', 'blockers')}` : `${records}, nothing blocks it`;
}

/** The step the request waits for, who may take it, and the fact worth knowing before taking it. */
export function nextStep(request: SubjectRequest, actor: Actor): NextStep {
  const erasure = request.kind === 'erasure';
  switch (request.status) {
    case 'received':
      return {
        task: 'Verify the identity',
        who: actor.canManage ? 'You' : 'Someone with the manage permission',
        mine: actor.canManage,
        fact: 'note how you checked, never what you copied',
      };
    case 'identity_verified':
      return {
        task: 'Run the assessment',
        who: actor.canManage ? 'You' : 'Someone with the manage permission',
        mine: actor.canManage,
        fact: 'counts what is held, changes nothing',
      };
    case 'assessed': {
      const verifier = request.identityVerifiedBy;
      const mine = actor.canManage && verifier !== actor.accountId;
      const other =
        verifier === actor.accountId ? 'you' : (request.identityVerifiedByName ?? 'the person who verified');
      return {
        task: erasure ? 'Approve the erasure' : 'Approve the access',
        who: mine ? 'You' : `Someone other than ${other}`,
        mine,
        fact: assessmentFact(request),
      };
    }
    case 'approved':
      return {
        task: erasure ? "Delete the person's data" : 'Build the export',
        who: actor.canExecute ? 'You' : 'Someone with the execute permission',
        mine: actor.canExecute,
        fact: assessmentFact(request),
      };
    case 'executing':
      return { task: 'Wait for the execution', who: 'The system', mine: false, fact: '' };
    case 'rejected':
      return { task: 'Nothing to do', who: '', mine: false, fact: request.rejectionReason };
    default: {
      const result = request.result;
      return {
        task: 'Nothing to do',
        who: '',
        mine: false,
        fact: result
          ? `${plural(totalRecords(result), 'record', 'records')} in ${plural(result.categories.length, 'category', 'categories')}`
          : '',
      };
    }
  }
}

export function statusSentence(request: SubjectRequest): string {
  switch (request.status) {
    case 'received':
      return 'Received';
    case 'identity_verified':
      return 'Identity verified, waiting for the assessment';
    case 'assessed':
      return 'Assessed, waiting for approval';
    case 'approved':
      return 'Approved, ready to execute';
    case 'executing':
      return 'Executing';
    case 'completed':
      return 'Completed';
    case 'partially_completed':
      return 'Completed, partially';
    default:
      return 'Rejected';
  }
}

/** The one line under the status sentence: who did the last step, and when. */
export function statusDetail(request: SubjectRequest): string {
  const by = (name: string | null, at: string | null, verb: string) =>
    `${verb}${name ? ` by ${name}` : ''}${at ? `, ${formatDate(at)}` : ''}`;
  switch (request.status) {
    case 'received':
      return `Recorded ${formatDate(request.receivedAt)}`;
    case 'identity_verified':
    case 'assessed':
      return by(request.identityVerifiedByName, request.identityVerifiedAt, 'Identity checked');
    case 'approved':
    case 'executing':
      return by(request.approvedByName, request.approvedAt, 'Approved');
    case 'rejected': {
      const last = request.steps.at(-1);
      const who = last?.actorName ?? 'System';
      return `${who}${last ? `, ${formatDate(last.occurredAt)}` : ''}${request.rejectionReason ? `: ${request.rejectionReason}` : ''}`;
    }
    default:
      return by(request.executedByName, request.executedAt ?? request.completedAt, 'Executed');
  }
}

/**
 * What the requests search matches: the person, the reference, the channel and kind labels, the status
 * (label, sentence and the line with the actor names) and the next step shown in the table.
 */
export function matchesRequestSearch(request: SubjectRequest, search: string, actor: Actor): boolean {
  const needle = search.trim().toLowerCase();
  if (needle === '') return true;
  const next = nextStep(request, actor);
  return [
    personLabel(request),
    request.reference,
    channelPhrases[request.channel],
    kindLabels[request.kind],
    statusLabels[request.status],
    statusSentence(request),
    statusDetail(request),
    next.task,
    next.fact,
  ].some((text) => text.toLowerCase().includes(needle));
}

/** When a closed request was closed: completion, else its last recorded step. */
export function closedAt(request: SubjectRequest): string | null {
  return request.completedAt ?? request.steps.at(-1)?.occurredAt ?? null;
}

export type DueInfo = { text: string; late: boolean; soon: boolean };

/** The countdown under a due date; closed requests say how long they took instead. */
export function dueInfo(request: SubjectRequest, now: number): DueInfo {
  if (isClosed(request)) {
    const closed = closedAt(request);
    if (!closed) return { text: 'closed', late: false, soon: false };
    const days = Math.max(0, Math.round((new Date(closed).getTime() - new Date(request.receivedAt).getTime()) / DAY));
    return {
      text: days === 0 ? 'closed the same day' : `closed in ${plural(days, 'day', 'days')}`,
      late: false,
      soon: false,
    };
  }
  const ms = new Date(request.dueAt).getTime() - now;
  if (ms < 0) {
    return { text: `overdue by ${plural(Math.max(1, Math.floor(-ms / DAY)), 'day', 'days')}`, late: true, soon: false };
  }
  const days = Math.ceil(ms / DAY);
  return { text: days === 0 ? 'due now' : `in ${plural(days, 'day', 'days')}`, late: false, soon: days <= 7 };
}

export function isDueSoon(request: SubjectRequest, now: number): boolean {
  return !isClosed(request) && new Date(request.dueAt).getTime() - now < 7 * DAY;
}

export function isClosedThisYear(request: SubjectRequest, now: number): boolean {
  const closed = closedAt(request);
  return (
    isClosed(request) &&
    closed !== null &&
    dateInAppTimeZone(closed).slice(0, 4) === dateInAppTimeZone(new Date(now)).slice(0, 4)
  );
}

/** The date one calendar month after a `YYYY-MM-DDTHH:mm` value, clamped to the end of a shorter month. */
export function oneMonthLater(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return '';
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const target = new Date(Date.UTC(year, month, Math.min(day, lastDay)));
  return formatDate(target.toISOString().slice(0, 10));
}
