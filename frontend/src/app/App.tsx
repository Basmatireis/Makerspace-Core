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
import { DeviceBridgeProvider } from '../features/terminal/DeviceBridgeProvider';

const ResetPasswordPage = lazy(() => import('../features/auth/ResetPasswordPage').then(({ ResetPasswordPage }) => ({ default: ResetPasswordPage })));
const InvitationPage = lazy(() => import('../features/auth/ResetPasswordPage').then(({ InvitationPage }) => ({ default: InvitationPage })));
const PINEnrollmentPage = lazy(() => import('../features/auth/ResetPasswordPage').then(({ PINEnrollmentPage }) => ({ default: PINEnrollmentPage })));
const EmailVerificationPage = lazy(() => import('../features/auth/ResetPasswordPage').then(({ EmailVerificationPage }) => ({ default: EmailVerificationPage })));
const VisitorEnrollmentPage = lazy(() => import('../features/visitor/VisitorEnrollmentPage').then(({ VisitorEnrollmentPage }) => ({ default: VisitorEnrollmentPage })));
const LegalPage = lazy(() => import('../features/branding/LegalPage').then(({ LegalPage }) => ({ default: LegalPage })));
const ProfilePage = lazy(() => import('../features/profile/ProfilePage').then(({ ProfilePage }) => ({ default: ProfilePage })));
const OrdersPage = lazy(() =>
  import('../features/orders/OrdersPage').then((m) => ({
    default: m.OrdersPage,
  })),
);
const OrderDetailPage = lazy(() =>
  import('../features/orders/OrderDetailPage').then((m) => ({
    default: m.OrderDetailPage,
  })),
);
const CounterSalePage = lazy(() =>
  import('../features/orders/CounterSalePage').then((m) => ({
    default: m.CounterSalePage,
  })),
);
const PaymentsPage = lazy(() =>
  import('../features/orders/PaymentsPage').then((m) => ({
    default: m.PaymentsPage,
  })),
);
const PaymentDetailPage = lazy(() =>
  import('../features/orders/PaymentsPage').then((m) => ({
    default: m.PaymentDetailPage,
  })),
);
const ExternalInvoicingPage = lazy(() =>
  import('../features/orders/ExternalInvoicingPage').then((m) => ({
    default: m.ExternalInvoicingPage,
  })),
);
const ExternalInvoiceDetailPage = lazy(() =>
  import('../features/orders/ExternalInvoicingPage').then((m) => ({
    default: m.ExternalInvoiceDetailPage,
  })),
);
const MachineLogbookOverviewPage = lazy(() => import('../features/machinelogbook/OverviewPage').then(({ MachineLogbookOverviewPage }) => ({ default: MachineLogbookOverviewPage })));
const JobsPage = lazy(() => import('../features/machinelogbook/JobsPage').then(({ JobsPage }) => ({ default: JobsPage })));
const JobDetailPage = lazy(() => import('../features/machinelogbook/JobDetailPage').then(({ JobDetailPage }) => ({ default: JobDetailPage })));
const ReviewPage = lazy(() => import('../features/machinelogbook/ReviewPage').then(({ ReviewPage }) => ({ default: ReviewPage })));
const InventoryPage = lazy(() => import('../features/machinelogbook/InventoryPage').then(({ InventoryPage }) => ({ default: InventoryPage })));
const MaterialDetailPage = lazy(() => import('../features/machinelogbook/MaterialDetailPage').then(({ MaterialDetailPage }) => ({ default: MaterialDetailPage })));
const MachinesPage = lazy(() => import('../features/machinelogbook/MachinesPage').then(({ MachinesPage }) => ({ default: MachinesPage })));
const StatisticsPage = lazy(() => import('../features/machinelogbook/StatisticsPage').then(({ StatisticsPage }) => ({ default: StatisticsPage })));
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
const ConfigurationPage = lazy(() => import('../features/machinelogbook/ConfigurationPage').then(({ ConfigurationPage }) => ({ default: ConfigurationPage })));
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

function OpenDayScheduleRedirect() {
  const { periodId = '' } = useParams();
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  params.set('mode', 'edit');

  return <Navigate to={{ pathname: `/open-days/${periodId}`, search: `?${params.toString()}`, hash: location.hash }} state={location.state} replace />;
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
		<Route path="settings/session-policies" element={<PermissionRoute allOf={[PermissionId.session_policiesmanage]}><SessionPoliciesPage /></PermissionRoute>} />
		<Route path="settings/surveys" element={<PermissionRoute anyOf={[PermissionId.surveysread, PermissionId.surveysmanage]}><SurveyAdminPage /></PermissionRoute>} />
		<Route path="settings/laborordnung" element={<PermissionRoute anyOf={[PermissionId.laborordnungread, PermissionId.laborordnungmanage, PermissionId.laborordnungrequestsread]}><LaborordnungPage /></PermissionRoute>} />
        <Route path="settings/oidc" element={<PermissionRoute allOf={[PermissionId.oidcmanage]}><OIDCProvidersPage /></PermissionRoute>} />
        <Route path="settings/scim" element={<PermissionRoute allOf={[PermissionId.scimmanage]}><SCIMConnectorsPage /></PermissionRoute>} />
        <Route path="settings/visitor-enrollment" element={<PermissionRoute allOf={[PermissionId.visitor_enrollmentmanage]}><VisitorEnrollmentSettingsPage /></PermissionRoute>} />
        <Route path="settings/mail" element={<PermissionRoute allOf={[PermissionId.mailmanage]}><MailSettingsPage /></PermissionRoute>} />
        <Route path="settings/branding-legal" element={<PermissionRoute allOf={[PermissionId.brandingmanage]}><BrandingLegalSettingsPage /></PermissionRoute>} />
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
        <Route
          path="orders"
          element={
            <PermissionRoute allOf={[PermissionId.ordersread]}>
              <OrdersPage />
            </PermissionRoute>
          }
        />
        <Route
          path="orders/counter-sale"
          element={
            <PermissionRoute
              allOf={[
                PermissionId.ordersread,
                PermissionId.orderswrite,
                PermissionId.ordersfinalize,
                PermissionId.paymentsread,
                PermissionId.paymentsrecord,
              ]}
            >
              <CounterSalePage />
            </PermissionRoute>
          }
        />
        <Route
          path="orders/:orderId"
          element={
            <PermissionRoute allOf={[PermissionId.ordersread]}>
              <OrderDetailPage />
            </PermissionRoute>
          }
        />
        <Route
          path="payments"
          element={
            <PermissionRoute allOf={[PermissionId.paymentsread]}>
              <PaymentsPage />
            </PermissionRoute>
          }
        />
        <Route
          path="payments/:paymentId"
          element={
            <PermissionRoute allOf={[PermissionId.paymentsread]}>
              <PaymentDetailPage />
            </PermissionRoute>
          }
        />
        <Route
          path="external-invoicing"
          element={
            <PermissionRoute
              allOf={[PermissionId.external_invoice_requestsread]}
            >
              <ExternalInvoicingPage />
            </PermissionRoute>
          }
        />
        <Route
          path="external-invoicing/:requestId"
          element={
            <PermissionRoute
              allOf={[PermissionId.external_invoice_requestsread]}
            >
              <ExternalInvoiceDetailPage />
            </PermissionRoute>
          }
        />
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
