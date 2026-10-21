import { queryOptions } from '@tanstack/react-query';
import { getWiRefDeliverySettings } from '../../api/generated/external-invoicing/external-invoicing';

export const wirefSettingsKey = ['invoicing', 'wiref-settings'] as const;

export const wirefSettingsQuery = () =>
  queryOptions({ queryKey: wirefSettingsKey, queryFn: ({ signal }) => getWiRefDeliverySettings({ signal }) });
