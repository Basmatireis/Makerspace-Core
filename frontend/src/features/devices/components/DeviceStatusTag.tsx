import { Tag } from '@carbon/react';
import type { ManagedDeviceStatus } from '../../../api/generated/models';

const tagTypes = { active: 'green', expired: 'warm-gray', revoked: 'red' } as const;

export function DeviceStatusTag({ status }: { status: ManagedDeviceStatus }) {
  return (
    <Tag size="sm" type={tagTypes[status]}>
      {status[0].toUpperCase() + status.slice(1)}
    </Tag>
  );
}
