import { queryOptions } from '@tanstack/react-query';
import type { CurrentUser, TrainingStatus } from '../../api/generated/models';
import {
  listCompetencyCategories,
  listPersonTrainingRecords,
  listTrainings,
} from '../../api/generated/trainings/trainings';
import { hasAnyPermission, hasPermission, PermissionId } from '../auth/permissions';

export const trainingKeys = {
  all: ['trainings'] as const,
  catalogue: () => [...trainingKeys.all, 'catalogue'] as const,
  trainings: () => [...trainingKeys.catalogue(), 'trainings'] as const,
  categories: () => [...trainingKeys.catalogue(), 'categories'] as const,
  records: (personId: string) => [...trainingKeys.all, 'records', personId] as const,
};

export const trainingsOptions = queryOptions({
  queryKey: trainingKeys.trainings(),
  queryFn: ({ signal }) => listTrainings({ signal }),
});

export const competencyCategoriesOptions = queryOptions({
  queryKey: trainingKeys.categories(),
  queryFn: ({ signal }) => listCompetencyCategories({ signal }),
});

export const trainingRecordsOptions = (personId: string) =>
  queryOptions({
    queryKey: trainingKeys.records(personId),
    queryFn: ({ signal }) => listPersonTrainingRecords(personId, { signal }),
  });

export const trainingStatusLabels: Record<TrainingStatus, string> = {
  not_trained: 'Not trained',
  trained: 'Trained',
  trainer: 'Can train others',
};

/** Frontend mirror of the backend scopes; the API enforces them again. */
export function canReadTrainingRecords(currentUser: CurrentUser, personId: string): boolean {
  if (hasAnyPermission(currentUser, [PermissionId.training_recordsreadall, PermissionId.training_recordsupdate]))
    return true;
  return currentUser.person.id === personId && hasPermission(currentUser, PermissionId.training_recordsreadself);
}

/** Nobody changes their own status, not even the master. */
export function canSetTrainingRecords(currentUser: CurrentUser, personId: string): boolean {
  return currentUser.person.id !== personId && hasPermission(currentUser, PermissionId.training_recordsupdate);
}
