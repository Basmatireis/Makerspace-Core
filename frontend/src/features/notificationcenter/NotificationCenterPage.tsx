import { lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { SettingsPageLayout } from '../settings/SettingsPageLayout';
import { SettingsTabs } from '../settings/SettingsTabs';
import { CategoriesTab } from './CategoriesTab';
import { RuleEditorPage } from './RuleEditorPage';
import { RulesTab } from './RulesTab';
import './notificationcenter.scss';

const ActivityTab = lazy(() => import('./ActivityTab').then((module) => ({ default: module.ActivityTab })));

function NotificationCenterHome() {
  const canRead = hasPermission(useCurrentUser(), PermissionId.notification_rulesread);
  return (
    <SettingsPageLayout page="notification-center" width="wide">
      <SettingsTabs
        label="Notification center"
        tabs={[
          { key: 'rules', label: 'Rules', panel: <RulesTab /> },
          { key: 'categories', label: 'Categories', panel: <CategoriesTab /> },
          ...(canRead ? [{ key: 'activity', label: 'Activity', panel: <ActivityTab /> }] : []),
        ]}
      />
    </SettingsPageLayout>
  );
}

/** Everything below `/settings/notifications` is one lazily loaded unit, so the application entry carries one route. */
export function NotificationCenterPage() {
  return (
    <Routes>
      <Route index element={<NotificationCenterHome />} />
      <Route path="rules/new" element={<RuleEditorPage />} />
      <Route path="rules/:ruleId" element={<RuleEditorPage />} />
      <Route path="*" element={<Navigate to="/settings/notifications" replace />} />
    </Routes>
  );
}
