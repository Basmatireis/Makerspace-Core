export function openDaySchedulePath(periodId: string, options: { editOpenDayId?: string; recurrence?: boolean } = {}) {
  const params = new URLSearchParams({ mode: 'edit' });
  if (options.editOpenDayId) params.set('edit', options.editOpenDayId);
  if (options.recurrence) params.set('recurrence', '1');
  return `/open-days/${periodId}?${params.toString()}`;
}
