import type {
  LaborordnungStatus,
  PeopleAccountStatusFilter,
  PeopleLaborordnungStatusFilter,
  Person,
} from '../../../api/generated/models';
import type { DeletionFailure } from '../deletionErrors';

export const PAGE_SIZES = [10, 25, 50, 100];
export const EMPTY_PEOPLE: Person[] = [];

export type FilterOption<T extends string> = {
  value: T;
  label: string;
};

export const ACCOUNT_STATUS_OPTIONS: Array<FilterOption<PeopleAccountStatusFilter>> = [
  { value: 'enabled', label: 'Active' },
  { value: 'disabled', label: 'Inactive' },
  { value: 'no_account', label: 'No account' },
];

export const LAB_RULES_STATUS_OPTIONS: Array<FilterOption<PeopleLaborordnungStatusFilter>> = [
  { value: 'current', label: 'Current' },
  { value: 'pending', label: 'Confirmation pending' },
  { value: 'outdated', label: 'Acknowledgement outdated' },
  { value: 'no_published_version', label: 'No published version' },
  { value: 'not_required', label: 'Not required' },
];

export type BatchAction = 'create-accounts' | 'assign-role' | 'delete-accounts' | 'delete-people' | null;
export type BatchResult = {
  kind: 'success' | 'warning';
  title: string;
  subtitle: string;
  failures?: DeletionFailure[];
};

export const fullName = (person: Person) => `${person.firstName} ${person.lastName}`.trim();

export type LabRulesStatusPresentation = {
  label: string;
  type: 'gray' | 'green' | 'purple' | 'warm-gray';
};

export function positiveInteger(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function peopleWithAccounts(people: Person[]): Person[] {
  return people.filter((person) => person.account && typeof person.account === 'object');
}

export function formatLabRulesStatus(status?: LaborordnungStatus): LabRulesStatusPresentation {
  if (!status) return { label: 'Unavailable', type: 'gray' };
  if (status.requestId) return { label: 'Confirmation pending', type: 'purple' };
  if (status.state === 'current') return { label: 'Current', type: 'green' };
  if (status.state === 'outdated') {
    return {
      label: 'Acknowledgement outdated',
      type: status.actionRequired ? 'warm-gray' : 'gray',
    };
  }
  if (status.state === 'no_published_version') {
    return { label: 'No published version', type: 'gray' };
  }
  return { label: 'Not required', type: 'gray' };
}

export const peopleEligibleForDeletion = (members: Person[], canDeleteAccounts: boolean) =>
  members.filter((member) => canDeleteAccounts || member.account === null);
