import { useQueryClient } from '@tanstack/react-query';
import { machineLogbookKeys } from '../machinelogbook/queries';

export const rateText = (rate: string) => rate.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1').replace('.', ',');

export function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
}
