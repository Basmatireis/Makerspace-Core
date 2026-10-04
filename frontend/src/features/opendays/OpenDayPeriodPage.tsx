import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { ScheduleEditorPage } from './ScheduleEditorPage';

export function OpenDayPeriodPage() {
  const currentUser = useCurrentUser();
  const canManage = hasPermission(currentUser, PermissionId.open_daysmanage);

  return <ScheduleEditorPage canManage={canManage} />;
}
