import { queryOptions } from '@tanstack/react-query';
import type { ListWorkingGroupProjectsParams } from '../../api/generated/models';
import {
  downloadWorkingGroupFinanceSignature,
  getWorkingGroupProject,
  listWorkingGroupProjects,
} from '../../api/generated/working-groups/working-groups';
import { workingGroupKeys } from './queries';

// Under the working-group key, so every working-group mutation reads them again.
const base = [...workingGroupKeys.all, 'projects'] as const;

export const projectsOptions = (params: ListWorkingGroupProjectsParams) =>
  queryOptions({
    queryKey: [...base, 'list', params.groupId ?? 'all', params.status ?? 'any'] as const,
    queryFn: ({ signal }) => listWorkingGroupProjects(params, { signal }),
  });

export const projectOptions = (projectId: string) =>
  queryOptions({
    queryKey: [...base, 'one', projectId] as const,
    queryFn: ({ signal }) => getWorkingGroupProject(projectId, { signal }),
  });

/** The saved signature of the caller as an image; a missing one (404) is an error the caller treats as none. */
export const savedSignatureOptions = queryOptions({
  queryKey: [...base, 'signature'] as const,
  queryFn: ({ signal }) => downloadWorkingGroupFinanceSignature({ signal }),
  retry: false,
  staleTime: 60_000,
});
