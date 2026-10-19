import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { PermissionId } from '../api/generated/models';
import { DashboardPage } from '../features/dashboard/DashboardPage';
import { LoginPage } from '../features/auth/LoginPage';
import { PermissionRoute, ProtectedRoute, useCurrentUser } from '../features/auth/auth';
import { canAccessSettings } from '../features/auth/permissions';
import { AppShell } from './AppShell';
import { NotFoundPage } from './NotFoundPage';
import { InformationPage } from './InformationPage';
import { FullPageLoading } from './PageState';
import { machineLogbookPaths } from '../features/machinelogbook/shared/paths';
import { useQuery } from '@tanstack/react-query';
import { requestQuery } from '../features/orders/queries';
import { DeviceBridgeProvider } from '../features/terminal/DeviceBridgeProvider';

const ResetPasswordPage = lazy(() => import('../features/auth/ResetPasswordPage').then(({ ResetPasswordPage }) => ({ default: ResetPasswordPage })));
const InvitationPage = lazy(() => import('../features/auth/ResetPasswordPage').then(({ InvitationPage }) => ({ default: InvitationPage })));
const PINEnrollmentPage = lazy(() => import('../features/auth/ResetPasswordPage').then(({ PINEnrollmentPage }) => ({ default: PINEnrollmentPage })));
const EmailVerificationPage = lazy(() => import('../features/auth/ResetPasswordPage').then(({ EmailVerificationPage }) => ({ default: EmailVerificationPage })));
const VisitorEnrollmentPage = lazy(() => import('../features/visitor/VisitorEnrollmentPage').then(({ VisitorEnrollmentPage }) => ({ default: VisitorEnrollmentPage })));
const LegalPage = lazy(() => import('../features/branding/LegalPage').then(({ LegalPage }) => ({ default: LegalPage })));
const ProfilePage = lazy(() => import('../features/profile/ProfilePage').then(({ ProfilePage }) => ({ default: ProfilePage })));
const SalesOverviewPage = lazy(() => import('../features/orders/SalesOverviewPage').then(({ SalesOverviewPage }) => ({ default: SalesOverviewPage })));
const OrdersPage = lazy(() => import('../features/orders/OrdersPage').then(({ OrdersPage }) => ({ default: OrdersPage })));
const OrderDetailPage = lazy(() => import('../features/orders/OrderDetailPage').then(({ OrderDetailPage }) => ({ default: OrderDetailPage })));
const ReceiptPage = lazy(() => import('../features/orders/ReceiptPage').then(({ ReceiptPage }) => ({ default: ReceiptPage })));
const PaymentsPage = lazy(() => import('../features/orders/PaymentsPage').then(({ PaymentsPage }) => ({ default: PaymentsPage })));
const PaymentDetailPage = lazy(() => import('../features/orders/PaymentDetailPage').then(({ PaymentDetailPage }) => ({ default: PaymentDetailPage })));
const PricingPage = lazy(() => import('../features/pricing/PricingPage').then(({ PricingPage }) => ({ default: PricingPage })));
const MachineLogbookLayout = lazy(() => import('../features/machinelogbook/shared/MachineLogbookLayout').then(({ MachineLogbookLayout }) => ({ default: MachineLogbookLayout })));
const MachineLogbookOverviewPage = lazy(() => import('../features/machinelogbook/OverviewPage').then(({ MachineLogbookOverviewPage }) => ({ default: MachineLogbookOverviewPage })));
const JobsPage = lazy(() => import('../features/machinelogbook/JobsPage').then(({ JobsPage }) => ({ default: JobsPage })));
const JobDetailPage = lazy(() => import('../features/machinelogbook/JobDetailPage').then(({ JobDetailPage }) => ({ default: JobDetailPage })));
const RunDetailPage = lazy(() => import('../features/machinelogbook/RunDetailPage').then(({ RunDetailPage }) => ({ default: RunDetailPage })));
const InventoryPage = lazy(() => import('../features/machinelogbook/InventoryPage').then(({ InventoryPage }) => ({ default: InventoryPage })));
const MaterialDetailPage = lazy(() => import('../features/machinelogbook/MaterialDetailPage').then(({ MaterialDetailPage }) => ({ default: MaterialDetailPage })));
const FilamentSpoolDetailPage = lazy(() => import('../features/machinelogbook/FilamentSpoolDetailPage').then(({ FilamentSpoolDetailPage }) => ({ default: FilamentSpoolDetailPage })));
const MachinesPage = lazy(() => import('../features/machinelogbook/MachinesPage').then(({ MachinesPage }) => ({ default: MachinesPage })));
const MachineDetailPage = lazy(() => import('../features/machinelogbook/MachineDetailPage').then(({ MachineDetailPage }) => ({ default: MachineDetailPage })));
const StatisticsPage = lazy(() => import('../features/machinelogbook/StatisticsPage').then(({ StatisticsPage }) => ({ default: StatisticsPage })));
const SignageDisplaysPage = lazy(() => import('../features/signage/DisplaysPage').then(({ DisplaysPage }) => ({ default: DisplaysPage })));
const SignageDisplayDetailPage = lazy(() => import('../features/signage/DisplayDetailPage').then(({ DisplayDetailPage }) => ({ default: DisplayDetailPage })));
const SignageAnnouncementsPage = lazy(() => import('../features/signage/AnnouncementsPage').then(({ AnnouncementsPage }) => ({ default: AnnouncementsPage })));
const SignageContentPage = lazy(() => import('../features/signage/ContentPage').then(({ ContentPage }) => ({ default: ContentPage })));
const SignageSceneEditorPage = lazy(() => import('../features/signage/SceneEditorPage').then(({ SceneEditorPage }) => ({ default: SceneEditorPage })));
const SignagePlaylistDetailPage = lazy(() => import('../features/signage/PlaylistDetailPage').then(({ PlaylistDetailPage }) => ({ default: PlaylistDetailPage })));
const SignageMediaPage = lazy(() => import('../features/signage/MediaPage').then(({ MediaPage }) => ({ default: MediaPage })));
const OpenDaysPage = lazy(() => import('../features/opendays/OpenDaysPage').then(({ OpenDaysPage }) => ({ default: OpenDaysPage })));
const OpenDayPeriodPage = lazy(() => import('../features/opendays/OpenDayPeriodPage').then(({ OpenDayPeriodPage }) => ({ default: OpenDayPeriodPage })));
const OpenDayDetailPage = lazy(() => import('../features/opendays/OpenDayDetailPage').then(({ OpenDayDetailPage }) => ({ default: OpenDayDetailPage })));
const OpenDayManagementPage = lazy(() => import('../features/opendays/OpenDayManagementPage').then(({ OpenDayManagementPage }) => ({ default: OpenDayManagementPage })));
const SettingsPage = lazy(() => import('../features/settings/SettingsPage').then(({ SettingsPage }) => ({ default: SettingsPage })));
const ManagedDevicesPage = lazy(() => import('../features/devices/ManagedDevicesPage').then(({ ManagedDevicesPage }) => ({ default: ManagedDevicesPage })));
const LaborordnungPage = lazy(() => import('../features/laborordnung/LaborordnungPage').then(({ LaborordnungPage }) => ({ default: LaborordnungPage })));
const OIDCProvidersPage = lazy(() => import('../features/oidc/OIDCProvidersPage').then(({ OIDCProvidersPage }) => ({ default: OIDCProvidersPage })));
const SCIMConnectorsPage = lazy(() => import('../features/scim/SCIMConnectorsPage').then(({ SCIMConnectorsPage }) => ({ default: SCIMConnectorsPage })));
const VisitorEnrollmentSettingsPage = lazy(() => import('../features/visitor/VisitorEnrollmentSettingsPage').then(({ VisitorEnrollmentSettingsPage }) => ({ default: VisitorEnrollmentSettingsPage })));
const MailSettingsPage = lazy(() => import('../features/mail/MailSettingsPage').then(({ MailSettingsPage }) => ({ default: MailSettingsPage })));
const BrandingLegalSettingsPage = lazy(() => import('../features/branding/BrandingLegalSettingsPage').then(({ BrandingLegalSettingsPage }) => ({ default: BrandingLegalSettingsPage })));
const OrganizationsPage = lazy(() => import('../features/organizations/OrganizationsPage').then(({ OrganizationsPage }) => ({ default: OrganizationsPage })));
const OrganizationDetailPage = lazy(() => import('../features/organizations/OrganizationDetailPage').then(({ OrganizationDetailPage }) => ({ default: OrganizationDetailPage })));
const UsersPage = lazy(() => import('../features/users/UsersPage').then(({ UsersPage }) => ({ default: UsersPage })));
const SupervisorStaffingPage = lazy(() => import('../features/users/SupervisorStaffingPage').then(({ SupervisorStaffingPage }) => ({ default: SupervisorStaffingPage })));
const UserCreatePage = lazy(() => import('../features/users/UserCreatePage').then(({ UserCreatePage }) => ({ default: UserCreatePage })));
const UserDetailPage = lazy(() => import('../features/users/UserDetailPage').then(({ UserDetailPage }) => ({ default: UserDetailPage })));
const ActivityPage = lazy(() => import('../features/audit/ActivityPage').then(({ ActivityPage }) => ({ default: ActivityPage })));
const RolesPage = lazy(() => import('../features/roles/RolesPage').then(({ RolesPage }) => ({ default: RolesPage })));
const EventsPage = lazy(() => import('../features/events/EventsPage').then(({ EventsPage }) => ({ default: EventsPage })));
const EventCreatePage = lazy(() => import('../features/events/EventCreatePage').then(({ EventCreatePage }) => ({ default: EventCreatePage })));
const EventDetailPage = lazy(() => import('../features/events/EventDetailPage').then(({ EventDetailPage }) => ({ default: EventDetailPage })));
const PublicEventPage = lazy(() => import('../features/events/PublicEventPage').then(({ PublicEventPage }) => ({ default: PublicEventPage })));
const EventSignupManagementPage = lazy(() => import('../features/events/EventSignupManagementPage').then(({ EventSignupManagementPage }) => ({ default: EventSignupManagementPage })));
const VisitorTerminalPage = lazy(() => import('../features/terminal/VisitorTerminalPage').then(({ VisitorTerminalPage }) => ({ default: VisitorTerminalPage })));
const PublicSurveyPage = lazy(() => import('../features/surveys/PublicSurveyPage').then(({ PublicSurveyPage }) => ({ default: PublicSurveyPage })));
const AttendancePage = lazy(() => import('../features/attendance/AttendancePage').then(({ AttendancePage }) => ({ default: AttendancePage })));
const SessionPoliciesPage = lazy(() => import('../features/devices/SessionPoliciesPage').then(({ SessionPoliciesPage }) => ({ default: SessionPoliciesPage })));
const SurveyAdminPage = lazy(() => import('../features/surveys/SurveyAdminPage').then(({ SurveyAdminPage }) => ({ default: SurveyAdminPage })));

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

/** The former request page: the invoice now lives on its order. */
function ExternalInvoiceRedirect() {
  const { requestId = '' } = useParams();
  const request = useQuery({ ...requestQuery(requestId), enabled: !!requestId });
  if (request.isError || (request.data && !request.data.orderId)) return <Navigate to="/orders" replace />;
  if (!request.data) return <FullPageLoading label="Loading page" />;
  return <Navigate to={`/orders/${request.data.orderId}`} replace />;
}

function OpenDayScheduleRedirect() {
  const { periodId = '' } = useParams();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('mode', 'edit');

  return <Navigate to={{ pathname: `/open-days/${periodId}`, search: `?${params.toString()}`, hash: location.hash }} state={location.state} replace />;
}

/** Redirects a former URL carrying one ID to its new path; the query string and hash are dropped on purpose. */
function IdRedirect({ param, to }: { param: string; to: (id: string) => string }) {
  const id = useParams()[param] ?? '';
  return <Navigate to={to(id)} replace />;
}

export function App() {
  return (
    <DeviceBridgeProvider>
    <Suspense fallback={<FullPageLoading label="Loading page" />}>
      <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/complete-invitation" element={<InvitationPage />} />
	  <Route path="/complete-pin-setup" element={<PINEnrollmentPage />} />
	  <Route path="/verify-email" element={<EmailVerificationPage />} />
      <Route path="/visitor-enrollment" element={<VisitorEnrollmentPage />} />
      <Route path="/terminal" element={<VisitorTerminalPage />} />
      <Route path="/survey/:token" element={<PublicSurveyPage />} />
      <Route path="/legal/imprint" element={<LegalPage kind="imprint" />} />
      <Route path="/legal/privacy" element={<LegalPage kind="privacy" />} />
      <Route path="/legal-and-privacy" element={<Navigate to="/legal/imprint" replace />} />
      <Route path="/events/public/:publicId" element={<PublicEventPage />} />
      <Route path="/events/signup/manage" element={<EventSignupManagementPage />} />
      <Route element={<ProtectedApp />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="profile" element={<ProfilePage />} />
		<Route path="attendance" element={<PermissionRoute anyOf={[PermissionId.attendanceread, PermissionId.attendanceassist, PermissionId.attendancestatisticsread]}><AttendancePage /></PermissionRoute>} />
		<Route path="events" element={<PermissionRoute anyOf={[PermissionId.eventsread, PermissionId.eventsmanage, PermissionId.eventsstaffingmanage, PermissionId.eventsassign]}><EventsPage /></PermissionRoute>} />
		<Route path="events/new" element={<PermissionRoute allOf={[PermissionId.eventsmanage]}><EventCreatePage /></PermissionRoute>} />
		<Route path="events/:eventId" element={<PermissionRoute anyOf={[PermissionId.eventsread, PermissionId.eventsmanage, PermissionId.eventsstaffingmanage, PermissionId.eventsassign]}><EventDetailPage /></PermissionRoute>} />
		<Route path="machine-logbook" element={<MachineLogbookLayout />}>
			<Route index element={<PermissionRoute anyOf={[PermissionId.machine_jobsread, PermissionId.statisticsread]}><MachineLogbookOverviewPage /></PermissionRoute>} />
			<Route path="jobs" element={<PermissionRoute allOf={[PermissionId.machine_jobsread]}><JobsPage /></PermissionRoute>} />
			<Route path="jobs/runs/:runId" element={<PermissionRoute allOf={[PermissionId.machine_jobsread]}><RunDetailPage /></PermissionRoute>} />
			<Route path="jobs/prints/:printId" element={<IdRedirect param="printId" to={machineLogbookPaths.run} />} />
			<Route path="jobs/:jobId" element={<PermissionRoute allOf={[PermissionId.machine_jobsread]}><JobDetailPage /></PermissionRoute>} />
			<Route path="machines" element={<PermissionRoute allOf={[PermissionId.machinesread]}><MachinesPage /></PermissionRoute>} />
			<Route path="machines/:machineId" element={<PermissionRoute allOf={[PermissionId.machinesread]}><MachineDetailPage /></PermissionRoute>} />
			<Route path="inventory" element={<PermissionRoute allOf={[PermissionId.inventoryread]}><InventoryPage /></PermissionRoute>} />
			<Route path="inventory/materials/:materialId" element={<PermissionRoute allOf={[PermissionId.inventoryread]}><MaterialDetailPage /></PermissionRoute>} />
			<Route path="inventory/spools/:spoolId" element={<PermissionRoute allOf={[PermissionId.inventoryread]}><FilamentSpoolDetailPage /></PermissionRoute>} />
			<Route path="statistics" element={<PermissionRoute allOf={[PermissionId.statisticsread]}><StatisticsPage /></PermissionRoute>} />
			{/* Former URLs. Static segments rank above `:materialId`, so "materials", "spools" and "products" never become an ID. */}
			<Route path="inventory/materials" element={<Navigate to="/machine-logbook/inventory?tab=materials" replace />} />
			<Route path="inventory/spools" element={<Navigate to="/machine-logbook/inventory?tab=spools" replace />} />
			<Route path="inventory/products" element={<Navigate to="/machine-logbook/inventory?tab=products" replace />} />
			<Route path="inventory/:materialId" element={<IdRedirect param="materialId" to={machineLogbookPaths.material} />} />
			<Route path="spools" element={<Navigate to="/machine-logbook/inventory?tab=spools" replace />} />
			<Route path="spools/:spoolId" element={<IdRedirect param="spoolId" to={machineLogbookPaths.spool} />} />
			<Route path="machines/:machineId/printer" element={<IdRedirect param="machineId" to={(id) => machineLogbookPaths.machine(id, 'printer')} />} />
		</Route>
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
        <Route path="signage" element={<PermissionRoute allOf={[PermissionId.signageread]}><SignageDisplaysPage /></PermissionRoute>} />
        <Route path="signage/displays/:displayId" element={<PermissionRoute allOf={[PermissionId.signageread]}><SignageDisplayDetailPage /></PermissionRoute>} />
        <Route path="signage/announcements" element={<PermissionRoute anyOf={[PermissionId.signageread, PermissionId.signageoverride]}><SignageAnnouncementsPage /></PermissionRoute>} />
        <Route path="signage/content" element={<PermissionRoute allOf={[PermissionId.signageread]}><SignageContentPage /></PermissionRoute>} />
        <Route path="signage/scenes/:sceneId" element={<PermissionRoute allOf={[PermissionId.signageread]}><SignageSceneEditorPage /></PermissionRoute>} />
        <Route path="signage/playlists/:playlistId" element={<PermissionRoute allOf={[PermissionId.signageread]}><SignagePlaylistDetailPage /></PermissionRoute>} />
        <Route path="signage/media" element={<PermissionRoute allOf={[PermissionId.signageread]}><SignageMediaPage /></PermissionRoute>} />
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
		<Route path="settings/session-policies" element={<PermissionRoute allOf={[PermissionId.session_policiesmanage]}><SessionPoliciesPage /></PermissionRoute>} />
		<Route path="settings/surveys" element={<PermissionRoute anyOf={[PermissionId.surveysread, PermissionId.surveysmanage]}><SurveyAdminPage /></PermissionRoute>} />
		<Route path="settings/laborordnung" element={<PermissionRoute anyOf={[PermissionId.laborordnungread, PermissionId.laborordnungmanage, PermissionId.laborordnungrequestsread]}><LaborordnungPage /></PermissionRoute>} />
        <Route path="settings/oidc" element={<PermissionRoute allOf={[PermissionId.oidcmanage]}><OIDCProvidersPage /></PermissionRoute>} />
        <Route path="settings/scim" element={<PermissionRoute allOf={[PermissionId.scimmanage]}><SCIMConnectorsPage /></PermissionRoute>} />
        <Route path="settings/printer-connectors" element={<Navigate to="/machine-logbook/machines?tab=connectors" replace />} />
        <Route path="settings/visitor-enrollment" element={<PermissionRoute allOf={[PermissionId.visitor_enrollmentmanage]}><VisitorEnrollmentSettingsPage /></PermissionRoute>} />
        <Route path="settings/mail" element={<PermissionRoute allOf={[PermissionId.mailmanage]}><MailSettingsPage /></PermissionRoute>} />
        <Route path="settings/branding-legal" element={<PermissionRoute allOf={[PermissionId.brandingmanage]}><BrandingLegalSettingsPage /></PermissionRoute>} />
        <Route path="settings/machine-logbook" element={<Navigate to="/pricing" replace />} />
        <Route
          path="people"
          element={<PermissionRoute allOf={[PermissionId.peoplereadall]}><UsersPage /></PermissionRoute>}
        />
        {/* The layout hosts the toast stack, so a deletion can confirm after leaving its page. */}
        <Route element={<MachineLogbookLayout />}>
          <Route path="sales" element={<PermissionRoute anyOf={[PermissionId.ordersread, PermissionId.paymentsread]}><SalesOverviewPage /></PermissionRoute>} />
          <Route path="orders" element={<PermissionRoute allOf={[PermissionId.ordersread]}><OrdersPage /></PermissionRoute>} />
          <Route path="orders/:orderId" element={<PermissionRoute allOf={[PermissionId.ordersread]}><OrderDetailPage /></PermissionRoute>} />
          <Route path="orders/:orderId/receipt" element={<PermissionRoute allOf={[PermissionId.ordersread, PermissionId.paymentsread]}><ReceiptPage /></PermissionRoute>} />
          <Route path="payments" element={<PermissionRoute allOf={[PermissionId.paymentsread]}><PaymentsPage /></PermissionRoute>} />
          <Route path="payments/:paymentId" element={<PermissionRoute allOf={[PermissionId.paymentsread]}><PaymentDetailPage /></PermissionRoute>} />
          <Route path="pricing" element={<PermissionRoute allOf={[PermissionId.pricingread]}><PricingPage /></PermissionRoute>} />
          <Route
            path="organizations"
            element={<PermissionRoute allOf={[PermissionId.organizationsread]}><OrganizationsPage /></PermissionRoute>}
          />
          <Route
            path="organizations/:organizationId"
            element={<PermissionRoute allOf={[PermissionId.organizationsread]}><OrganizationDetailPage /></PermissionRoute>}
          />
        </Route>
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
        <Route path="external-invoicing" element={<Navigate to="/orders?invoice=draft,submitted" replace />} />
        <Route path="external-invoicing/:requestId" element={<ExternalInvoiceRedirect />} />
        <Route path="audit-log" element={<PermissionRoute allOf={[PermissionId.auditread]}><ActivityPage /></PermissionRoute>} />
        <Route path="about" element={<InformationPage title="About" />} />
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
    </Suspense>
    </DeviceBridgeProvider>
  );
}
