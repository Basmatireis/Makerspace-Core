import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { PermissionId } from '../api/generated/models';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { LoginPage } from '../features/auth/LoginPage';
import { PermissionRoute, ProtectedRoute, useCurrentUser } from '../features/auth/auth';
import { canAccessSettings } from '../features/auth/permissions';
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
import { OpenDayManagementPage } from '../features/opendays/OpenDayManagementPage';
import { LaborordnungPage } from '../features/laborordnung/LaborordnungPage';
import { SupervisorStaffingPage } from '../features/users/SupervisorStaffingPage';
import { OIDCProvidersPage } from '../features/oidc/OIDCProvidersPage';
import { SCIMConnectorsPage } from '../features/scim/SCIMConnectorsPage';
import { VisitorEnrollmentPage } from '../features/visitor/VisitorEnrollmentPage';
import { VisitorEnrollmentSettingsPage } from '../features/visitor/VisitorEnrollmentSettingsPage';
import { MailSettingsPage } from '../features/mail/MailSettingsPage';
import { MachineLogbookOverviewPage } from '../features/machinelogbook/OverviewPage';
import { JobsPage } from '../features/machinelogbook/JobsPage';
import { JobDetailPage } from '../features/machinelogbook/JobDetailPage';
import { ReviewPage } from '../features/machinelogbook/ReviewPage';
import { InventoryPage } from '../features/machinelogbook/InventoryPage';
import { MaterialDetailPage } from '../features/machinelogbook/MaterialDetailPage';
import { MachinesPage } from '../features/machinelogbook/MachinesPage';
import { StatisticsPage } from '../features/machinelogbook/StatisticsPage';
import { ConfigurationPage } from '../features/machinelogbook/ConfigurationPage';
import { AppShell } from './AppShell';
import { NotFoundPage } from './NotFoundPage';
import { ActivityPage } from '../features/audit/ActivityPage';
import { InformationPage } from './InformationPage';

function ProtectedApp() {
  return (
    <ProtectedRoute>
      <AppShell />
    </ProtectedRoute>
  );
}

function SettingsRoute() {
  const currentUser = useCurrentUser();
  return canAccessSettings(currentUser) ? <SettingsPage /> : <Navigate to="/dashboard" replace />;
}

function LegacyRedirect({ from, to }: { from: string; to: string }) {
  const location = useLocation();
  const suffix = location.pathname.slice(from.length);

  return (
    <Navigate
      to={{ pathname: `${to}${suffix}`, search: location.search, hash: location.hash }}
      replace
    />
  );
}

function OpenDayScheduleRedirect() {
  const { periodId = '' } = useParams();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('mode', 'edit');

  return <Navigate to={{ pathname: `/open-days/${periodId}`, search: `?${params.toString()}`, hash: location.hash }} state={location.state} replace />;
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
		<Route path="machine-logbook" element={<PermissionRoute anyOf={[PermissionId.machine_jobsread, PermissionId.statisticsread]}><MachineLogbookOverviewPage /></PermissionRoute>} />
		<Route path="machine-logbook/jobs" element={<PermissionRoute allOf={[PermissionId.machine_jobsread]}><JobsPage /></PermissionRoute>} />
		<Route path="machine-logbook/jobs/:jobId" element={<PermissionRoute allOf={[PermissionId.machine_jobsread]}><JobDetailPage /></PermissionRoute>} />
		<Route path="machine-logbook/review" element={<PermissionRoute allOf={[PermissionId.machine_jobsreview]}><ReviewPage /></PermissionRoute>} />
		<Route path="machine-logbook/inventory" element={<PermissionRoute allOf={[PermissionId.inventoryread]}><InventoryPage /></PermissionRoute>} />
		<Route path="machine-logbook/inventory/:materialId" element={<PermissionRoute allOf={[PermissionId.inventoryread]}><MaterialDetailPage /></PermissionRoute>} />
		<Route path="machine-logbook/machines" element={<PermissionRoute allOf={[PermissionId.machinesread]}><MachinesPage /></PermissionRoute>} />
		<Route path="machine-logbook/statistics" element={<PermissionRoute allOf={[PermissionId.statisticsread]}><StatisticsPage /></PermissionRoute>} />
		<Route path="supervisors" element={<LegacyRedirect from="/supervisors" to="/people/staffing" />} />
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
          element={<PermissionRoute allOf={[PermissionId.open_daysmanage]}><OpenDayScheduleRedirect /></PermissionRoute>}
        />
        <Route
          path="open-days/manage"
          element={<PermissionRoute allOf={[PermissionId.open_daysmanage]}><OpenDayManagementPage /></PermissionRoute>}
        />
        <Route
          path="settings"
          element={<SettingsRoute />}
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
        <Route path="settings/machine-logbook" element={<PermissionRoute allOf={[PermissionId.organizationsread, PermissionId.pricingread, PermissionId.machinesread]}><ConfigurationPage /></PermissionRoute>} />
        <Route
          path="people"
          element={<PermissionRoute allOf={[PermissionId.peoplereadall]}><UsersPage /></PermissionRoute>}
        />
        <Route
          path="people/staffing"
          element={<PermissionRoute allOf={[PermissionId.supervisor_dashboardread]}><SupervisorStaffingPage /></PermissionRoute>}
        />
        <Route
          path="people/new"
          element={<PermissionRoute allOf={[PermissionId.peoplecreate]}><UserCreatePage /></PermissionRoute>}
        />
        <Route
          path="people/:personId"
          element={<PermissionRoute allOf={[PermissionId.peoplereadall]}><UserDetailPage /></PermissionRoute>}
        />
        <Route path="audit-log" element={<PermissionRoute allOf={[PermissionId.auditread]}><ActivityPage /></PermissionRoute>} />
        <Route path="about" element={<InformationPage title="About" />} />
        <Route path="legal-and-privacy" element={<InformationPage title="Legal & Privacy" />} />
        <Route path="settings/users/*" element={<LegacyRedirect from="/settings/users" to="/people" />} />
        <Route path="settings/activity" element={<LegacyRedirect from="/settings/activity" to="/audit-log" />} />
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
