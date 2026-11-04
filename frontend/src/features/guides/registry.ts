import { useQuery } from '@tanstack/react-query';
import type { GuideDefinition } from './types';

/** The guide definitions are a separate chunk: they are only needed once someone opens the help center or a tour. */
export const loadGuides = (): Promise<GuideDefinition[]> => import('./content').then((module) => module.guides);

export function useGuideRegistry() {
  // Code, not server data; it never changes during a page load.
  return useQuery({ queryKey: ['guides', 'registry'], queryFn: loadGuides, staleTime: Infinity });
}
