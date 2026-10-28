import type {
  PeopleMergeCandidate,
  PeopleMergeCategory,
  PeopleMergeConflictCode,
  PeopleMergeExpectedVersion,
  PeopleMergeField,
  PeopleMergeFieldSources,
  PeopleMergePreview,
} from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';

/** The most people one merge takes (the target and nine sources). */
export const MAX_MERGE_PEOPLE = 10;

/** Fields in the order the comparison table shows them. */
export const MERGE_FIELDS: ReadonlyArray<{ field: PeopleMergeField; label: string }> = [
  { field: 'firstName', label: 'First name' },
  { field: 'lastName', label: 'Last name' },
  { field: 'email', label: 'Email and login' },
  { field: 'phone', label: 'Phone' },
  { field: 'matriculationNumber', label: 'Matriculation number' },
  { field: 'photoReference', label: 'Photo reference' },
  { field: 'profileImage', label: 'Profile image' },
  { field: 'memberSince', label: 'Member since' },
];

export type FieldChoices = Partial<Record<PeopleMergeField, string>>;

/** The comparable value of a field; null when the person has none. Images compare by stored file. */
export function fieldValue(person: PeopleMergeCandidate, field: PeopleMergeField): string | null {
  switch (field) {
    case 'email':
      return person.email ?? person.account?.loginEmail ?? null;
    case 'profileImage':
      return person.profileImage?.fileId ?? null;
    case 'matriculationNumber':
      return person.matriculationNumber ?? null;
    default:
      return person[field] || null;
  }
}

/** Fields worth a row: the matriculation number only when the response carries it, and only if values exist. */
export function comparedFields(people: PeopleMergeCandidate[]) {
  return MERGE_FIELDS.filter(({ field }) => {
    if (field === 'matriculationNumber' && !people.some((person) => 'matriculationNumber' in person)) return false;
    if (field === 'photoReference' || field === 'profileImage') {
      return people.some((person) => fieldValue(person, field) !== null);
    }
    return true;
  });
}

/** The person whose Account survives and therefore whose email can be kept. */
export function survivingAccountPersonId(preview: PeopleMergePreview): string | null {
  if (!preview.survivingAccountId) return null;
  return preview.people.find((person) => person.account?.id === preview.survivingAccountId)?.id ?? null;
}

/**
 * The person each field comes from when nobody chooses: the target's value, or for optional fields the first
 * non-empty value in the order target, then sources. This mirrors the server default, so choices equal to it need
 * not be sent (and a matriculation number is only sent when the person deliberately changed it).
 */
export function defaultFieldChoices(preview: PeopleMergePreview): FieldChoices {
  const target = preview.people.find((person) => person.id === preview.targetPersonId) ?? preview.people[0];
  const ordered = [target, ...preview.people.filter((person) => person.id !== target.id)];
  const choices: FieldChoices = {};
  for (const { field } of MERGE_FIELDS) {
    if (field === 'email') {
      choices.email = survivingAccountPersonId(preview) ?? target.id;
    } else if (field === 'firstName' || field === 'lastName' || field === 'memberSince') {
      choices[field] = target.id;
    } else {
      choices[field] = (ordered.find((person) => fieldValue(person, field) !== null) ?? target).id;
    }
  }
  return choices;
}

/** Only the fields whose choice differs from the default are sent; the rest follows the server default. */
export function buildFieldSources(preview: PeopleMergePreview, choices: FieldChoices): PeopleMergeFieldSources {
  const defaults = defaultFieldChoices(preview);
  const sources: PeopleMergeFieldSources = {};
  for (const { field } of comparedFields(preview.people)) {
    const chosen = choices[field];
    if (chosen && chosen !== defaults[field]) sources[field] = chosen;
  }
  return sources;
}

export function expectedVersions(preview: PeopleMergePreview): PeopleMergeExpectedVersion[] {
  return preview.people.map((person) => ({
    personId: person.id,
    version: person.version,
    accountVersion: person.account?.version ?? null,
  }));
}

export const conflictMessages: Record<PeopleMergeConflictCode, string> = {
  source_scim_managed:
    'A person to be deleted is provisioned through SCIM. Choose the SCIM-managed person as the one that stays, or remove them in the identity provider.',
  actor_is_source: 'You are one of the people to be deleted. Choose yourself as the person that stays.',
  open_visit_conflict: 'More than one of these people is currently checked in. Check them out first.',
  attendance_hold_conflict:
    'More than one of these people has a pending Lab Rules check-in hold. Resolve the holds first.',
  lab_rules_request_conflict: 'These people have pending Lab Rules requests for different versions.',
  open_day_assignment_conflict: 'These people hold different positions on the same open day.',
  pin_conflict: 'More than one of these accounts has a PIN. Remove all but one first.',
  totp_conflict: 'More than one of these accounts has a confirmed authenticator app. Reset all but one first.',
  master_merge_forbidden: 'Someone involved holds the master role. Only a master can merge them.',
  role_assignment_forbidden: 'You may not assign every role the merged person would hold.',
  last_master_required: 'The merge would leave no enabled master account.',
};

export const categoryLabels: Record<PeopleMergeCategory, string> = {
  visits: 'Visits',
  attendance_holds: 'Attendance holds',
  training_records: 'Training records',
  lab_rules_requests: 'Lab Rules requests',
  open_day_assignments: 'Open day assignments',
  event_shift_assignments: 'Event shift assignments',
  event_planning: 'Owned events and tasks',
  orders: 'Orders',
  machine_jobs: 'Machine jobs',
  invoice_requests: 'Invoice requests',
  cash_movements: 'Cash movements',
  survey_invitations: 'Survey invitations',
  survey_responses: 'Survey responses',
  organization_memberships: 'Organization memberships',
  notifications: 'Notifications',
  privacy_holds: 'Retention holds and data requests',
  actor_references: 'Recorded actions',
  authentication_methods: 'Authentication methods',
  audit_events: 'Audit events',
};

export type MergeFailure = { kind: 'stale' | 'blocked' | 'error'; title: string; messages: string[] };

type ErrorPayload = {
  code?: string;
  message?: string;
  details?: { reasons?: Array<{ code?: string; message?: string }> };
};

/** Translates a failed merge into messages the person can act on. */
export function describeMergeFailure(error: unknown): MergeFailure {
  if (!(error instanceof ApiError)) {
    return { kind: 'error', title: 'The merge was not performed', messages: ['The server could not be reached.'] };
  }
  const data = error.data as ErrorPayload | undefined;
  const code = data?.code;
  const known = (value?: string) =>
    value && value in conflictMessages ? conflictMessages[value as PeopleMergeConflictCode] : undefined;
  if (error.status === 409 && code === 'stale_write') {
    return {
      kind: 'stale',
      title: 'Someone changed these people',
      messages: ['A person or account changed since the preview. Run the preview again to see the current state.'],
    };
  }
  if (error.status === 409) {
    const reasons = data?.details?.reasons ?? [];
    const messages = (reasons.length ? reasons : [data ?? {}]).map(
      (reason) => known(reason.code) ?? reason.message ?? error.message,
    );
    return { kind: 'blocked', title: 'The merge is blocked', messages };
  }
  if (error.status === 403) {
    const message =
      code === 'reauthentication_required'
        ? 'A fresh sign-in is required for merging people. Sign in again and retry.'
        : (known(code) ?? 'You are not allowed to perform this merge, or to choose this matriculation number.');
    return { kind: 'error', title: 'Not permitted', messages: [message] };
  }
  if (error.status === 422 && code === 'merge_email_requires_account') {
    return {
      kind: 'error',
      title: 'Choose another email',
      messages: ['The merged person keeps an account, so the email must come from a person who has one.'],
    };
  }
  if (error.status === 404) {
    return {
      kind: 'error',
      title: 'Person not found',
      messages: ['One of the people no longer exists or is not visible to you.'],
    };
  }
  return {
    kind: 'error',
    title: 'The merge was not performed',
    messages: [data?.message ?? `Unexpected server error${error.requestId ? ` (request ${error.requestId})` : ''}.`],
  };
}
