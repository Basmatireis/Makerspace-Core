import { useSimulatedQuery, useStore } from '../store';

/** Honors the loading / error / empty data-state scenario for signage lists and detail pages. `data` is the empty value outside the success state. */
export function useSignageQuery<T>(data: T, emptyValue: T) {
  const store = useStore();
  const query = useSimulatedQuery<number>(() => 0, 0);
  return { ...query, empty: store.scenario === 'empty', data: query.status === 'success' && store.scenario !== 'empty' ? data : emptyValue };
}
