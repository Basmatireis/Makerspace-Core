import { useSearchParams } from 'react-router-dom';

/** Filter state kept in the address bar, so a filtered list can be bookmarked and survives a reload. Changing a filter returns to page 1. */
export function useUrlParams() {
  const [params, setParams] = useSearchParams();
  const update = (patch: Record<string, string | null>) => setParams((previous) => {
    const next = new URLSearchParams(previous);
    for (const [key, value] of Object.entries(patch)) { if (value) next.set(key, value); else next.delete(key); }
    if (!('page' in patch)) next.delete('page');
    return next;
  }, { replace: true });
  const list = (key: string) => (params.get(key) ?? '').split(',').filter(Boolean);
  const toggleIn = (key: string, id: string, checked: boolean) => { const current = list(key); update({ [key]: (checked ? [...current, id] : current.filter((item) => item !== id)).join(',') || null }); };
  return { params, update, list, toggleIn };
}
