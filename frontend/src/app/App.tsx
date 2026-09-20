import { Navigate, Route, Routes } from 'react-router-dom';
import { PermissionId } from '../api/generated/models';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { LoginPage } from '../features/auth/LoginPage';
import { PermissionRoute, ProtectedRoute } from '../features/auth/auth';
import { settingsPermissions } from '../features/auth/permissions';
import { EmailVerificationPage, InvitationPage, PINEnrollmentPage, ResetPasswordPage } from '../features/auth/ResetPasswordPage';
import { ProfilePage } from '../features/profile/ProfilePage';
import { RolesPage } from '../features/roles/RolesPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { ManagedDevicesPage } from '../features/devices/ManagedDevicesPage';
import { UserCreatePage } from '../features/users/UserCreatePage';
import { UserDetailPage } from '../features/users/UserDetailPage';
import { UsersPage } from '../features/users/UsersPage';
import { OpenDaysPage } from '../features/opendays/OpenDaysPage';
import { OpenDayPeriodPage } from '../features/opendays/OpenDayPeriodPage';
import { OpenDayDetailPage } from '../features/opendays/OpenDayDetailPage';
import { ScheduleEditorPage } from '../features/opendays/ScheduleEditorPage';
import { OpenDayManagementPage } from '../features/opendays/OpenDayManagementPage';
import { LaborordnungPage } from '../features/laborordnung/LaborordnungPage';
import { SupervisorDashboardPage } from '../features/supervisors/SupervisorDashboardPage';
import { OIDCProvidersPage } from '../features/oidc/OIDCProvidersPage';
import { SCIMConnectorsPage } from '../features/scim/SCIMConnectorsPage';
import { VisitorEnrollmentPage } from '../features/visitor/VisitorEnrollmentPage';
import { VisitorEnrollmentSettingsPage } from '../features/visitor/VisitorEnrollmentSettingsPage';
import { MailSettingsPage } from '../features/mail/MailSettingsPage';
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
      <Route path="/complete-invitation" element={<InvitationPage />} />
	  <Route path="/complete-pin-setup" element={<PINEnrollmentPage />} />
	  <Route path="/verify-email" element={<EmailVerificationPage />} />
      <Route path="/visitor-enrollment" element={<VisitorEnrollmentPage />} />
      <Route element={<ProtectedApp />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="profile" element={<ProfilePage />} />
		<Route path="supervisors" element={<PermissionRoute allOf={[PermissionId.supervisor_dashboardread]}><SupervisorDashboardPage /></PermissionRoute>} />
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
            <PermissionRoute anyOf={settingsPermissions}>
              <SettingsPage />
            </PermissionRoute>
          }
        />
        <Route
          path="settings/managed-devices"
          element={(
            <PermissionRoute allOf={[PermissionId.managed_devicesread]}>
              <ManagedDevicesPage />
            </PermissionRoute>
          )}
        />
		<Route path="settings/laborordnung" element={<PermissionRoute anyOf={[PermissionId.laborordnungread, PermissionId.laborordnungmanage, PermissionId.laborordnungrequestsread]}><LaborordnungPage /></PermissionRoute>} />
        <Route path="settings/oidc" element={<PermissionRoute allOf={[PermissionId.oidcmanage]}><OIDCProvidersPage /></PermissionRoute>} />
        <Route path="settings/scim" element={<PermissionRoute allOf={[PermissionId.scimmanage]}><SCIMConnectorsPage /></PermissionRoute>} />
        <Route path="settings/visitor-enrollment" element={<PermissionRoute allOf={[PermissionId.visitor_enrollmentmanage]}><VisitorEnrollmentSettingsPage /></PermissionRoute>} />
        <Route path="settings/mail" element={<PermissionRoute allOf={[PermissionId.mailmanage]}><MailSettingsPage /></PermissionRoute>} />
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
          element={<PermissionRoute allOf={[PermissionId.rolesread, PermissionId.rolesmanage]}><RolesPage /></PermissionRoute>}
        />
        <Route
          path="settings/roles/:roleId"
          element={<PermissionRoute allOf={[PermissionId.rolesread]}><RolesPage /></PermissionRoute>}
        />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
