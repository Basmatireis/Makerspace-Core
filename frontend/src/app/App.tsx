import { Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { LoginPage } from '../features/auth/LoginPage';
import { PermissionRoute, ProtectedRoute, useCurrentUser } from '../features/auth/auth';
import { canAccessSettings } from '../features/auth/permissions';
import { AppShell } from './AppShell';
import { NotFoundPage } from './NotFoundPage';
import { InformationPage } from './InformationPage';
import { FullPageLoading } from './PageState';
import { machineLogbookPaths } from '../features/machinelogbook/shared/paths';
import { DeviceBridgeProvider } from '../features/kiosk/DeviceBridgeProvider';
import {
  ActivityPage,
  AttendancePage,
  BrandingLegalSettingsPage,
  DashboardPage,
  EmailVerificationPage,
  EventCreatePage,
  EventDetailPage,
  EventSignupManagementPage,
  EventsPage,
  ExternalInvoiceRedirect,
  FilamentSpoolDetailPage,
  GatewayDetailPage,
  InventoryPage,
  InvitationPage,
  InvoicingSettingsPage,
  JobDetailPage,
  JobsPage,
  LaborordnungPage,
  LegalPage,
  LocalServicesPage,
  ConfigurationTransferPage,
  MachineDetailPage,
  MachineLogbookLayout,
  MachineLogbookOverviewPage,
  MachinesPage,
  MailSettingsPage,
  MaterialDetailPage,
  OpenDayDetailPage,
  OpenDayManagementPage,
  OpenDayPeriodPage,
  OpenDaysPage,
  OrderDetailPage,
  OrdersPage,
  OrganizationDetailPage,
  OrganizationsPage,
  PINEnrollmentPage,
  PaymentDetailPage,
  PaymentsPage,
  PricingPage,
  ProfilePage,
  PublicEventPage,
  PublicSurveyPage,
  ReceiptPage,
  ResetPasswordPage,
  RolesPage,
  RunDetailPage,
  OpenDayRequirementsPage,
  TrainingsSettingsPage,
  SalesOverviewPage,
  SettingsPage,
  SingleSignOnPage,
  DevicesSessionsPage,
  SignageAnnouncementsPage,
  SignageContentPage,
  SignageCustomLayoutEditorPage,
  SignageDisplayDetailPage,
  SignageDisplaysPage,
  SignageMediaPage,
  SignagePlaylistDetailPage,
  SignageSceneEditorPage,
  StatisticsPage,
  SupervisorStaffingPage,
  SurveyAdminPage,
  UserCreatePage,
  UserDetailPage,
  UsersPage,
  VisitorEnrollmentPage,
  VisitorEnrollmentSettingsPage,
  VisitorKioskPage,
  MessagesPage,
  PeopleMergePage,
} from './routes';
import { IdRedirect, LegacyRedirect, OpenDayScheduleRedirect } from './routeRedirects';

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
          <Route path="/kiosk" element={<VisitorKioskPage />} />
          {/* Devices registered before the rename still open the old path. */}
          <Route path="/terminal" element={<Navigate to="/kiosk" replace />} />
          <Route path="/survey/*" element={<PublicSurveyPage />} />
          <Route path="/legal/imprint" element={<LegalPage kind="imprint" />} />
          <Route path="/legal/privacy" element={<LegalPage kind="privacy" />} />
          <Route path="/legal-and-privacy" element={<Navigate to="/legal/imprint" replace />} />
          <Route path="/events/public/:publicId" element={<PublicEventPage />} />
          <Route path="/events/signup/manage" element={<EventSignupManagementPage />} />
          <Route element={<ProtectedApp />}>
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<DashboardPage />} />
            <Route path="profile" element={<ProfilePage />} />
            <Route
              path="attendance"
              element={
                <PermissionRoute anyOf={['attendance.read', 'attendance.assist', 'attendance.statistics.read']}>
                  <AttendancePage />
                </PermissionRoute>
              }
            />
            <Route
              path="events"
              element={
                <PermissionRoute anyOf={['events.read', 'events.manage', 'events.staffing.manage', 'events.assign']}>
                  <EventsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="events/new"
              element={
                <PermissionRoute allOf={['events.manage']}>
                  <EventCreatePage />
                </PermissionRoute>
              }
            />
            <Route
              path="events/:eventId"
              element={
                <PermissionRoute anyOf={['events.read', 'events.manage', 'events.staffing.manage', 'events.assign']}>
                  <EventDetailPage />
                </PermissionRoute>
              }
            />
            <Route path="machine-logbook" element={<MachineLogbookLayout />}>
              <Route
                index
                element={
                  <PermissionRoute anyOf={['machine_jobs.read', 'statistics.read']}>
                    <MachineLogbookOverviewPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="jobs"
                element={
                  <PermissionRoute allOf={['machine_jobs.read']}>
                    <JobsPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="jobs/runs/:runId"
                element={
                  <PermissionRoute allOf={['machine_jobs.read']}>
                    <RunDetailPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="jobs/prints/:printId"
                element={<IdRedirect param="printId" to={machineLogbookPaths.run} />}
              />
              <Route
                path="jobs/:jobId"
                element={
                  <PermissionRoute allOf={['machine_jobs.read']}>
                    <JobDetailPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="machines"
                element={
                  <PermissionRoute allOf={['machines.read']}>
                    <MachinesPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="machines/:machineId"
                element={
                  <PermissionRoute allOf={['machines.read']}>
                    <MachineDetailPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="inventory"
                element={
                  <PermissionRoute allOf={['inventory.read']}>
                    <InventoryPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="inventory/materials/:materialId"
                element={
                  <PermissionRoute allOf={['inventory.read']}>
                    <MaterialDetailPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="inventory/spools/:spoolId"
                element={
                  <PermissionRoute allOf={['inventory.read']}>
                    <FilamentSpoolDetailPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="statistics"
                element={
                  <PermissionRoute allOf={['statistics.read']}>
                    <StatisticsPage />
                  </PermissionRoute>
                }
              />
              {/* Former URLs. Static segments rank above `:materialId`, so "materials", "spools" and "products" never become an ID. */}
              <Route
                path="inventory/materials"
                element={<Navigate to="/machine-logbook/inventory?tab=materials" replace />}
              />
              <Route
                path="inventory/spools"
                element={<Navigate to="/machine-logbook/inventory?tab=spools" replace />}
              />
              <Route
                path="inventory/products"
                element={<Navigate to="/machine-logbook/inventory?tab=materials" replace />}
              />
              <Route
                path="inventory/:materialId"
                element={<IdRedirect param="materialId" to={machineLogbookPaths.material} />}
              />
              <Route path="spools" element={<Navigate to="/machine-logbook/inventory?tab=spools" replace />} />
              <Route path="spools/:spoolId" element={<IdRedirect param="spoolId" to={machineLogbookPaths.spool} />} />
              <Route
                path="machines/:machineId/printer"
                element={<IdRedirect param="machineId" to={(id) => machineLogbookPaths.machine(id, 'printer')} />}
              />
            </Route>
            <Route path="supervisors" element={<LegacyRedirect from="/supervisors" to="/people/staffing" />} />
            <Route
              path="open-days"
              element={
                <PermissionRoute anyOf={['open_days.read', 'open_days.manage']}>
                  <OpenDaysPage />
                </PermissionRoute>
              }
            />
            <Route
              path="open-days/:periodId"
              element={
                <PermissionRoute anyOf={['open_days.read', 'open_days.manage']}>
                  <OpenDayPeriodPage />
                </PermissionRoute>
              }
            />
            <Route
              path="open-days/:periodId/days/:openDayId"
              element={
                <PermissionRoute anyOf={['open_days.read', 'open_days.manage']}>
                  <OpenDayDetailPage />
                </PermissionRoute>
              }
            />
            <Route
              path="open-days/:periodId/schedule"
              element={
                <PermissionRoute allOf={['open_days.manage']}>
                  <OpenDayScheduleRedirect />
                </PermissionRoute>
              }
            />
            <Route
              path="open-days/manage"
              element={
                <PermissionRoute allOf={['open_days.manage']}>
                  <OpenDayManagementPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage"
              element={
                <PermissionRoute allOf={['signage.read']}>
                  <SignageDisplaysPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/displays/:displayId"
              element={
                <PermissionRoute allOf={['signage.read']}>
                  <SignageDisplayDetailPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/announcements"
              element={
                <PermissionRoute anyOf={['signage.read', 'signage.override']}>
                  <SignageAnnouncementsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/content"
              element={
                <PermissionRoute allOf={['signage.read']}>
                  <SignageContentPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/scenes/:sceneId"
              element={
                <PermissionRoute allOf={['signage.read']}>
                  <SignageSceneEditorPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/playlists/:playlistId"
              element={
                <PermissionRoute allOf={['signage.read']}>
                  <SignagePlaylistDetailPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/layouts/new"
              element={
                <PermissionRoute allOf={['signage.read', 'signage.content.manage']}>
                  <SignageCustomLayoutEditorPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/layouts/:layoutId"
              element={
                <PermissionRoute allOf={['signage.read']}>
                  <SignageCustomLayoutEditorPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/media"
              element={
                <PermissionRoute allOf={['signage.read']}>
                  <SignageMediaPage />
                </PermissionRoute>
              }
            />
            <Route path="settings" element={<SettingsRoute />} />
            <Route
              path="settings/single-sign-on"
              element={
                <PermissionRoute anyOf={['oidc.manage', 'scim.manage']}>
                  <SingleSignOnPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/devices-sessions/*"
              element={
                <PermissionRoute anyOf={['session_policies.manage', 'managed_devices.read']}>
                  <DevicesSessionsPage />
                </PermissionRoute>
              }
            />
            <Route path="settings/oidc" element={<Navigate to="/settings/single-sign-on?tab=oidc" replace />} />
            <Route path="settings/scim" element={<Navigate to="/settings/single-sign-on?tab=scim" replace />} />
            <Route
              path="settings/session-policies"
              element={<Navigate to="/settings/devices-sessions?tab=session-policies" replace />}
            />
            <Route
              path="settings/managed-devices"
              element={<Navigate to="/settings/devices-sessions?tab=managed-devices" replace />}
            />
            <Route
              path="settings/open-days"
              element={
                <PermissionRoute allOf={['open_days.manage']}>
                  <OpenDayRequirementsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/trainings"
              element={
                <PermissionRoute allOf={['trainings.manage']}>
                  <TrainingsSettingsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/surveys/*"
              element={
                <PermissionRoute anyOf={['surveys.read', 'surveys.manage']}>
                  <SurveyAdminPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/laborordnung"
              element={
                <PermissionRoute anyOf={['laborordnung.read', 'laborordnung.manage', 'laborordnung.requests.read']}>
                  <LaborordnungPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/configuration-transfer"
              element={
                <PermissionRoute anyOf={['configuration.export', 'configuration.import']}>
                  <ConfigurationTransferPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/local-services"
              element={
                <PermissionRoute anyOf={['local_services.manage', 'printer_connectors.read']}>
                  <LocalServicesPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/local-services/:gatewayId"
              element={
                <PermissionRoute allOf={['local_services.manage']}>
                  <GatewayDetailPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/printer-connectors"
              element={<Navigate to={machineLogbookPaths.connectors()} replace />}
            />
            <Route
              path="settings/visitor-enrollment"
              element={
                <PermissionRoute allOf={['visitor_enrollment.manage']}>
                  <VisitorEnrollmentSettingsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/mail"
              element={
                <PermissionRoute allOf={['mail.manage']}>
                  <MailSettingsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/invoicing"
              element={
                <PermissionRoute allOf={['invoicing.settings.manage']}>
                  <InvoicingSettingsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/branding-legal"
              element={
                <PermissionRoute allOf={['branding.manage']}>
                  <BrandingLegalSettingsPage />
                </PermissionRoute>
              }
            />
            <Route path="settings/machine-logbook" element={<Navigate to="/pricing" replace />} />
            <Route
              path="people"
              element={
                <PermissionRoute allOf={['people.read.all']}>
                  <UsersPage />
                </PermissionRoute>
              }
            />
            {/* The layout hosts the toast stack, so a deletion can confirm after leaving its page. */}
            <Route element={<MachineLogbookLayout />}>
              <Route
                path="sales"
                element={
                  <PermissionRoute anyOf={['orders.read', 'payments.read']}>
                    <SalesOverviewPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="orders"
                element={
                  <PermissionRoute allOf={['orders.read']}>
                    <OrdersPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="orders/:orderId"
                element={
                  <PermissionRoute allOf={['orders.read']}>
                    <OrderDetailPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="orders/:orderId/receipt"
                element={
                  <PermissionRoute allOf={['orders.read', 'payments.read']}>
                    <ReceiptPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="payments"
                element={
                  <PermissionRoute allOf={['payments.read']}>
                    <PaymentsPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="payments/:paymentId"
                element={
                  <PermissionRoute allOf={['payments.read']}>
                    <PaymentDetailPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="pricing"
                element={
                  <PermissionRoute allOf={['pricing.read']}>
                    <PricingPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="organizations"
                element={
                  <PermissionRoute allOf={['organizations.read']}>
                    <OrganizationsPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="organizations/:organizationId"
                element={
                  <PermissionRoute allOf={['organizations.read']}>
                    <OrganizationDetailPage />
                  </PermissionRoute>
                }
              />
            </Route>
            <Route
              path="people/staffing"
              element={
                <PermissionRoute allOf={['supervisor_dashboard.read']}>
                  <SupervisorStaffingPage />
                </PermissionRoute>
              }
            />
            <Route
              path="notifications/messages"
              element={
                <PermissionRoute allOf={['notifications.send']}>
                  <MessagesPage />
                </PermissionRoute>
              }
            />
            <Route
              path="people/new"
              element={
                <PermissionRoute allOf={['people.create']}>
                  <UserCreatePage />
                </PermissionRoute>
              }
            />
            <Route
              path="people/merge"
              element={
                <PermissionRoute allOf={['people.merge', 'people.read.all']}>
                  <PeopleMergePage />
                </PermissionRoute>
              }
            />
            <Route
              path="people/:personId"
              element={
                <PermissionRoute allOf={['people.read.all']}>
                  <UserDetailPage />
                </PermissionRoute>
              }
            />
            <Route path="external-invoicing" element={<Navigate to="/orders?invoice=draft,submitted" replace />} />
            <Route path="external-invoicing/:requestId" element={<ExternalInvoiceRedirect />} />
            <Route
              path="audit-log"
              element={
                <PermissionRoute allOf={['audit.read']}>
                  <ActivityPage />
                </PermissionRoute>
              }
            />
            <Route path="about" element={<InformationPage title="About" />} />
            <Route path="settings/users/*" element={<LegacyRedirect from="/settings/users" to="/people" />} />
            <Route path="settings/activity" element={<LegacyRedirect from="/settings/activity" to="/audit-log" />} />
            <Route
              path="settings/roles"
              element={
                <PermissionRoute allOf={['roles.read']}>
                  <RolesPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/roles/new"
              element={
                <PermissionRoute allOf={['roles.read', 'roles.manage']}>
                  <RolesPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/roles/:roleId"
              element={
                <PermissionRoute allOf={['roles.read']}>
                  <RolesPage />
                </PermissionRoute>
              }
            />
            <Route path="*" element={<NotFoundPage />} />
          </Route>
        </Routes>
      </Suspense>
    </DeviceBridgeProvider>
  );
}
