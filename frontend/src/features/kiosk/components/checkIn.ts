import {
  terminalPasswordCheckIn,
  terminalPasswordCheckOut,
  terminalPinCheckIn,
  terminalPinCheckOut,
} from '../../../api/generated/attendance/attendance';
import type { Visit } from '../../../api/generated/models';
import { apiErrorCode } from '../../../api/http-client';

export type KioskAuthMethod = 'pin' | 'password';

/** What the person typed. It lives only in component state and is dropped when the flow ends or goes idle. */
export type Credentials = { method: KioskAuthMethod; identifier: string; secret: string };

/** How the person handles the Lab Rules in this check-in: confirm the given revision, or defer ("Later"). */
export type LabRulesChoice = { confirmVersionId: string } | { defer: true };

export function checkIn(credentials: Credentials, labRules?: LabRulesChoice): Promise<Visit> {
  const extra = !labRules
    ? {}
    : 'defer' in labRules
      ? { deferLabRules: true }
      : { confirmLabRulesVersionId: labRules.confirmVersionId };
  return credentials.method === 'password'
    ? terminalPasswordCheckIn({ email: credentials.identifier, password: credentials.secret, ...extra })
    : terminalPinCheckIn({ loginName: credentials.identifier, pin: credentials.secret, ...extra });
}

export function checkOut(credentials: Credentials): Promise<Visit> {
  return credentials.method === 'password'
    ? terminalPasswordCheckOut({ email: credentials.identifier, password: credentials.secret })
    : terminalPinCheckOut({ loginName: credentials.identifier, pin: credentials.secret });
}

/** `blocking`: the person must confirm to be checked in; `warning`: they may also choose "Later". */
export type LabRulesNeed = 'blocking' | 'warning';

/** The Lab Rules need announced by a refused check-in (409), or null for every other failure. */
export function labRulesNeed(error: unknown): LabRulesNeed | null {
  switch (apiErrorCode(error)) {
    case 'lab_rules_confirmation_required':
      return 'blocking';
    case 'lab_rules_confirmation_suggested':
      return 'warning';
    default:
      return null;
  }
}
