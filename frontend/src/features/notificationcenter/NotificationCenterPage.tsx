import { Navigate, Route, Routes } from 'react-router-dom';
import { SettingsPageLayout } from '../settings/SettingsPageLayout';
import { SettingsTabs } from '../settings/SettingsTabs';
import { CategoriesTab } from './CategoriesTab';
import { RuleEditorPage } from './RuleEditorPage';
import { RulesTab } from './RulesTab';
import './notificationcenter.scss';

function NotificationCenterHome() {
  return (
    <SettingsPageLayout page="notification-center" width="wide">
      <SettingsTabs
        label="Notification center"
        tabs={[
          { key: 'rules', label: 'Rules', panel: <RulesTab /> },
          { key: 'categories', label: 'Categories', panel: <CategoriesTab /> },
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
