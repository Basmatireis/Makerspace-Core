import { Navigate, Route, Routes } from 'react-router-dom';
import { PermissionId } from '../api/generated/models';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { LoginPage } from '../features/auth/LoginPage';
import { PermissionRoute, ProtectedRoute } from '../features/auth/auth';
import { ResetPasswordPage } from '../features/auth/ResetPasswordPage';
import { ProfilePage } from '../features/profile/ProfilePage';
import { RoleCreatePage } from '../features/roles/RoleCreatePage';
import { RoleDetailPage } from '../features/roles/RoleDetailPage';
import { RolesPage } from '../features/roles/RolesPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { UserCreatePage } from '../features/users/UserCreatePage';
import { UserDetailPage } from '../features/users/UserDetailPage';
import { UsersPage } from '../features/users/UsersPage';
import { OpenDaysPage } from '../features/opendays/OpenDaysPage';
import { OpenDayPeriodPage } from '../features/opendays/OpenDayPeriodPage';
import { OpenDayDetailPage } from '../features/opendays/OpenDayDetailPage';
import { ScheduleEditorPage } from '../features/opendays/ScheduleEditorPage';
import { OpenDayManagementPage } from '../features/opendays/OpenDayManagementPage';
import { AppShell } from './AppShell';
import { NotFoundPage } from './NotFoundPage';

function ProtectedApp() {
  return (
    <ProtectedRoute>
      <AppShell />
    </ProtectedRoute>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route element={<ProtectedApp />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="profile" element={<ProfilePage />} />
        <Route
          path="open-days"
          element={<PermissionRoute anyOf={[PermissionId.open_daysread, PermissionId.open_daysmanage]}><OpenDaysPage /></PermissionRoute>}
        />
        <Route
          path="open-days/:periodId"
          element={<PermissionRoute anyOf={[PermissionId.open_daysread, PermissionId.open_daysmanage]}><OpenDayPeriodPage /></PermissionRoute>}
        />
        <Route
          path="open-days/:periodId/days/:openDayId"
          element={<PermissionRoute anyOf={[PermissionId.open_daysread, PermissionId.open_daysmanage]}><OpenDayDetailPage /></PermissionRoute>}
        />
        <Route
          path="open-days/:periodId/schedule"
          element={<PermissionRoute allOf={[PermissionId.open_daysmanage]}><ScheduleEditorPage /></PermissionRoute>}
        />
        <Route
          path="open-days/manage"
          element={<PermissionRoute allOf={[PermissionId.open_daysmanage]}><OpenDayManagementPage /></PermissionRoute>}
        />
        <Route
          path="settings"
          element={
            <PermissionRoute anyOf={[PermissionId.peoplereadall, PermissionId.rolesread]}>
              <SettingsPage />
            </PermissionRoute>
          }
        />
        <Route
          path="settings/users"
          element={<PermissionRoute allOf={[PermissionId.peoplereadall]}><UsersPage /></PermissionRoute>}
        />
        <Route
          path="settings/users/new"
          element={<PermissionRoute allOf={[PermissionId.peoplecreate]}><UserCreatePage /></PermissionRoute>}
        />
        <Route
          path="settings/users/:personId"
          element={<PermissionRoute allOf={[PermissionId.peoplereadall]}><UserDetailPage /></PermissionRoute>}
        />
        <Route
          path="settings/roles"
          element={<PermissionRoute allOf={[PermissionId.rolesread]}><RolesPage /></PermissionRoute>}
        />
        <Route
          path="settings/roles/new"
          element={<PermissionRoute allOf={[PermissionId.rolesread, PermissionId.rolesmanage]}><RoleCreatePage /></PermissionRoute>}
        />
        <Route
          path="settings/roles/:roleId"
          element={<PermissionRoute allOf={[PermissionId.rolesread]}><RoleDetailPage /></PermissionRoute>}
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
