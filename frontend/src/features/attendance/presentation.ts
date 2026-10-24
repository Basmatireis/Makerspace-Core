import type { AttendanceHold, LaborordnungRequest } from '../../api/generated/models';

const methodLabels: Record<string, string> = {
  pin: 'Tablet · PIN',
  password: 'Tablet · password',
  supervisor: 'Assisted',
  oidc: 'Single sign-on',
  nfc: 'Card',
  enrollment: 'Enrollment',
};

export function checkInMethodLabel(method: string) {
  return methodLabels[method] ?? method;
}

export function labRulesProblem(previousRevision: string | null, requiredRevision: string | null) {
  return previousRevision === null
    ? 'Has never signed the Lab Rules'
    : `Signed revision ${previousRevision}, current is ${requiredRevision ?? 'unknown'}`;
}

/** What the confirmation form needs; built from a held check-in or from a queue request. */
export type ConfirmSubject = {
  key: string;
  requestId: string;
  displayName: string;
  requiredRevision: string | null;
  problem: string;
};

export function subjectFromHold(hold: AttendanceHold): ConfirmSubject | null {
  if (!hold.laborordnungRequestId) return null;
  return {
    key: hold.id,
    requestId: hold.laborordnungRequestId,
    displayName: hold.displayName,
    requiredRevision: hold.requiredRevision ?? null,
    problem: labRulesProblem(hold.previousRevision ?? null, hold.requiredRevision ?? null),
  };
}

export function subjectFromRequest(request: LaborordnungRequest): ConfirmSubject {
  const required = request.requiredVersion.humanRevision;
  return {
    key: request.id,
    requestId: request.id,
    displayName: request.personName,
    requiredRevision: required,
    problem: labRulesProblem(request.previousVersion?.humanRevision ?? null, required),
  };
}

export function isHold(result: object): result is AttendanceHold {
  return 'expiresAt' in result;
}
