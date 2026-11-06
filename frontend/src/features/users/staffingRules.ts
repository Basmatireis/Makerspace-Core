import type {
  StaffingCountBy,
  StaffingDefaultDeadline,
  StaffingRules,
  SupervisorRow,
  UpdateStaffingRulesRequest,
} from '../../api/generated/models';

/** One exception as the form edits it; the minimum stays text while typing so an empty field can be reported. */
export type ExceptionDraft = { roleId: string; roleName: string; minimum: string };

export type RulesDraft = {
  supervisorMinimum: string;
  traineeMinimum: string;
  traineeReadyAfter: string;
  warningWindowDays: string;
  countBy: StaffingCountBy;
  defaultDeadline: StaffingDefaultDeadline;
  exceptions: ExceptionDraft[];
};

export type NumberField = 'supervisorMinimum' | 'traineeMinimum' | 'traineeReadyAfter' | 'warningWindowDays';

/** Allowed ranges, the same as the API's. */
export const NUMBER_LIMITS: Record<NumberField, { min: number; max: number }> = {
  supervisorMinimum: { min: 0, max: 20 },
  traineeMinimum: { min: 0, max: 20 },
  traineeReadyAfter: { min: 1, max: 20 },
  warningWindowDays: { min: 1, max: 60 },
};

export const MAX_EXCEPTIONS = 200;

export function toDraft(rules: StaffingRules): RulesDraft {
  return {
    supervisorMinimum: String(rules.supervisorMinimum),
    traineeMinimum: String(rules.traineeMinimum),
    traineeReadyAfter: String(rules.traineeReadyAfter),
    warningWindowDays: String(rules.warningWindowDays),
    countBy: rules.countBy,
    defaultDeadline: rules.defaultDeadline,
    exceptions: rules.exceptions.map((exception) => ({
      roleId: exception.roleId,
      roleName: exception.roleName,
      minimum: String(exception.minimum),
    })),
  };
}

/** Whether the draft differs from the saved rules. */
export function isDirty(draft: RulesDraft, rules: StaffingRules): boolean {
  return JSON.stringify(draft) !== JSON.stringify(toDraft(rules));
}

const wholeNumber = (value: string) => (/^\d+$/.test(value.trim()) ? Number(value) : null);

function rangeError(value: string, limits: { min: number; max: number }): string | null {
  const parsed = wholeNumber(value);
  if (parsed === null) return 'Enter a whole number.';
  if (parsed < limits.min || parsed > limits.max) return `Use a number from ${limits.min} to ${limits.max}.`;
  return null;
}

export type RulesErrors = {
  numbers: Partial<Record<NumberField, string>>;
  /** Keyed by the exception's role id. */
  exceptions: Record<string, string>;
  duplicateRole: boolean;
};

export function validateDraft(draft: RulesDraft): RulesErrors {
  const numbers: RulesErrors['numbers'] = {};
  (Object.keys(NUMBER_LIMITS) as NumberField[]).forEach((field) => {
    const message = rangeError(draft[field], NUMBER_LIMITS[field]);
    if (message) numbers[field] = message;
  });
  const exceptions: RulesErrors['exceptions'] = {};
  for (const exception of draft.exceptions) {
    const message = rangeError(exception.minimum, { min: 0, max: 20 });
    if (message) exceptions[exception.roleId] = message;
  }
  const ids = draft.exceptions.map((exception) => exception.roleId);
  return { numbers, exceptions, duplicateRole: new Set(ids).size !== ids.length };
}

export const isValid = (errors: RulesErrors) =>
  Object.keys(errors.numbers).length === 0 && Object.keys(errors.exceptions).length === 0 && !errors.duplicateRole;

export function toRequest(draft: RulesDraft, expectedVersion: number): UpdateStaffingRulesRequest {
  return {
    supervisorMinimum: Number(draft.supervisorMinimum),
    traineeMinimum: Number(draft.traineeMinimum),
    traineeReadyAfter: Number(draft.traineeReadyAfter),
    warningWindowDays: Number(draft.warningWindowDays),
    countBy: draft.countBy,
    defaultDeadline: draft.defaultDeadline,
    exceptions: draft.exceptions.map((exception) => ({
      roleId: exception.roleId,
      minimum: Number(exception.minimum),
    })),
    expectedVersion,
  };
}

/**
 * What an exception does, in words: whom it reaches among the supervisors and trainees and whether it lowers their
 * minimum. A person's minimum is the lowest of their membership minimum and the exceptions of their extra roles.
 */
export function exceptionNote(
  exception: Pick<ExceptionDraft, 'roleName' | 'minimum'>,
  rows: readonly SupervisorRow[],
  draft: Pick<RulesDraft, 'supervisorMinimum' | 'traineeMinimum'>,
): string {
  const holders = rows.filter((row) => row.extraRoles.includes(exception.roleName));
  if (holders.length === 0) return 'Nobody has this role yet.';
  const minimum = wholeNumber(exception.minimum);
  const base = (row: SupervisorRow) =>
    wholeNumber(row.membership === 'supervisor' ? draft.supervisorMinimum : draft.traineeMinimum);
  const lowered = minimum === null ? 0 : holders.filter((row) => minimum < (base(row) ?? Infinity)).length;
  const people = `${holders.length} ${holders.length === 1 ? 'person' : 'people'}`;
  if (lowered === 0) return `${people} · not lower than their system role minimum, so it changes nothing`;
  const who = lowered === holders.length ? (holders.length === 1 ? 'them' : 'all of them') : String(lowered);
  return `${people} · lowers the minimum for ${who}`;
}
