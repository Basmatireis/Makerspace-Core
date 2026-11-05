import { Link as CarbonLink } from '@carbon/react';
import { Link } from 'react-router-dom';
import type { Order } from '../../api/generated/models';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { formatQuantity } from '../machinelogbook/shared/format';
import { machineLogbookPaths } from '../machinelogbook/shared/paths';
import { insufficientStock } from './logic';
import { unitDisplay } from '../machinelogbook/units';

/** An error message of an order operation. A finalization refused for missing stock names the article, the loose stock and links to the article. */
export function OrderErrorText({ error, order }: { error: Error; order: Pick<Order, 'items'> }) {
  const user = useCurrentUser();
  const shortage = insufficientStock(error);
  if (!shortage) return <>{error.message}</>;
  const item = order.items.find((candidate) => candidate.sourceMaterialId === shortage.materialId);
  const available =
    shortage.available === ''
      ? 'none'
      : `${formatQuantity(shortage.available, 6)}${item ? ` ${unitDisplay(item.unit)}` : ''}`;
  return (
    <>
      Not enough loose stock for {item?.description ?? 'this article'}: {available} available.
      {shortage.materialId && hasPermission(user, PermissionId.inventoryread) && (
        <>
          {' '}
          <CarbonLink as={Link} to={machineLogbookPaths.material(shortage.materialId)}>
            Open the article
          </CarbonLink>
        </>
      )}
    </>
  );
}
