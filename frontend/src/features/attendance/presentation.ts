import type { AttendanceHold } from '../../api/generated/models';

const methodLabels: Record<string, string> = {
  pin: 'Tablet · PIN',
  password: 'Tablet · password',
  supervisor: 'Assisted',
  oidc: 'Single sign-on',
  nfc: 'Card',
};

export function checkInMethodLabel(method: string) {
  return methodLabels[method] ?? method;
}

export function labRulesProblem(hold: AttendanceHold) {
  return hold.previousRevision === null
    ? 'Has never signed the Lab Rules'
    : `Signed revision ${hold.previousRevision}, current is ${hold.requiredRevision ?? 'unknown'}`;
}

export function isHold(result: object): result is AttendanceHold {
  return 'expiresAt' in result;
}
