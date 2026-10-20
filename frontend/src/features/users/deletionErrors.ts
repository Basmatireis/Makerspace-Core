import { ApiError } from '../../api/http-client';

export type DeletionTarget = 'person' | 'account';

type ReasonPayload = { code?: string; message?: string };
type ErrorPayload = ReasonPayload & { details?: { reasons?: ReasonPayload[] } };

const knownReasons: Record<string, string> = {
  person_scim_managed: 'Provisioned through SCIM. Remove them in the identity provider instead.',
  account_scim_managed: 'Provisioned through SCIM. Remove the account in the identity provider instead.',
  last_master_required: 'This is the last enabled master account. Assign the master role to someone else first.',
  stale_write: 'Changed since the list was loaded. Reload and try again.',
};

function reasonText(reason: ReasonPayload, fallback: string): string {
  return (reason.code && knownReasons[reason.code]) || reason.message || fallback;
}

// Translates a deletion failure into one actionable reason per blocking cause.
export function deletionFailureReasons(error: unknown, target: DeletionTarget): string[] {
  if (!(error instanceof ApiError)) return ['The server could not be reached. Check the connection and try again.'];
  const data = error.data as ErrorPayload | undefined;
  if (error.status === 409) {
    const reasons = data?.details?.reasons?.filter((reason) => reason.code || reason.message);
    if (reasons?.length) return reasons.map((reason) => reasonText(reason, error.message));
    return [reasonText(data ?? {}, error.message)];
  }
  if (data?.code && knownReasons[data.code]) return [knownReasons[data.code]];
  if (error.status === 403) {
    return [
      target === 'person'
        ? 'You are not allowed to delete this person or their account.'
        : 'You are not allowed to delete this account.',
    ];
  }
  if (error.status === 404) return ['Already deleted or no longer visible to you.'];
  return [`Unexpected server error${error.requestId ? ` (request ${error.requestId})` : ''}.`];
}

export type DeletionFailure = { name: string; reasons: string[] };
