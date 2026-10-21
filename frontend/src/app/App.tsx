import { Suspense } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { PermissionId } from '../api/generated/models';
import { LoginPage } from '../features/auth/LoginPage';
import { PermissionRoute, ProtectedRoute, useCurrentUser } from '../features/auth/auth';
import { canAccessSettings } from '../features/auth/permissions';
import { AppShell } from './AppShell';
import { NotFoundPage } from './NotFoundPage';
import { InformationPage } from './InformationPage';
import { FullPageLoading } from './PageState';
import { machineLogbookPaths } from '../features/machinelogbook/shared/paths';
import { DeviceBridgeProvider } from '../features/terminal/DeviceBridgeProvider';
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
  FilamentSpoolDetailPage,
  GatewayDetailPage,
  InventoryPage,
  InvitationPage,
  JobDetailPage,
  JobsPage,
  LaborordnungPage,
  LegalPage,
  LocalServicesPage,
  MachineDetailPage,
  MachineLogbookLayout,
  MachineLogbookOverviewPage,
  MachinesPage,
  MailSettingsPage,
  ManagedDevicesPage,
  MaterialDetailPage,
  OIDCProvidersPage,
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
  SCIMConnectorsPage,
  OpenDayRequirementsPage,
  SalesOverviewPage,
  SessionPoliciesPage,
  SettingsPage,
  SignageAnnouncementsPage,
  SignageContentPage,
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
  VisitorTerminalPage,
} from './routes';
import { ExternalInvoiceRedirect, IdRedirect, LegacyRedirect, OpenDayScheduleRedirect } from './routeRedirects';

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
            <Route
              path="attendance"
              element={
                <PermissionRoute
                  anyOf={[
                    PermissionId.attendanceread,
                    PermissionId.attendanceassist,
                    PermissionId.attendancestatisticsread,
                  ]}
                >
                  <AttendancePage />
                </PermissionRoute>
              }
            />
            <Route
              path="events"
              element={
                <PermissionRoute
                  anyOf={[
                    PermissionId.eventsread,
                    PermissionId.eventsmanage,
                    PermissionId.eventsstaffingmanage,
                    PermissionId.eventsassign,
                  ]}
                >
                  <EventsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="events/new"
              element={
                <PermissionRoute allOf={[PermissionId.eventsmanage]}>
                  <EventCreatePage />
                </PermissionRoute>
              }
            />
            <Route
              path="events/:eventId"
              element={
                <PermissionRoute
                  anyOf={[
                    PermissionId.eventsread,
                    PermissionId.eventsmanage,
                    PermissionId.eventsstaffingmanage,
                    PermissionId.eventsassign,
                  ]}
                >
                  <EventDetailPage />
                </PermissionRoute>
              }
            />
            <Route path="machine-logbook" element={<MachineLogbookLayout />}>
              <Route
                index
                element={
                  <PermissionRoute anyOf={[PermissionId.machine_jobsread, PermissionId.statisticsread]}>
                    <MachineLogbookOverviewPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="jobs"
                element={
                  <PermissionRoute allOf={[PermissionId.machine_jobsread]}>
                    <JobsPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="jobs/runs/:runId"
                element={
                  <PermissionRoute allOf={[PermissionId.machine_jobsread]}>
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
                  <PermissionRoute allOf={[PermissionId.machine_jobsread]}>
                    <JobDetailPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="machines"
                element={
                  <PermissionRoute allOf={[PermissionId.machinesread]}>
                    <MachinesPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="machines/:machineId"
                element={
                  <PermissionRoute allOf={[PermissionId.machinesread]}>
                    <MachineDetailPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="inventory"
                element={
                  <PermissionRoute allOf={[PermissionId.inventoryread]}>
                    <InventoryPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="inventory/materials/:materialId"
                element={
                  <PermissionRoute allOf={[PermissionId.inventoryread]}>
                    <MaterialDetailPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="inventory/spools/:spoolId"
                element={
                  <PermissionRoute allOf={[PermissionId.inventoryread]}>
                    <FilamentSpoolDetailPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="statistics"
                element={
                  <PermissionRoute allOf={[PermissionId.statisticsread]}>
                    <StatisticsPage />
                  </PermissionRoute>
                }
              />
              {/* Former URLs. Static segments rank above `:materialId`, so "materials", "spools" and "products" never become an ID. */}
              <Route
                path="inventory/materials"
                element={<Navigate to="/machine-logbook/inventory?tab=filament" replace />}
              />
              <Route
                path="inventory/spools"
                element={<Navigate to="/machine-logbook/inventory?tab=spools" replace />}
              />
              <Route
                path="inventory/products"
                element={<Navigate to="/machine-logbook/inventory?tab=filament" replace />}
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
                <PermissionRoute anyOf={[PermissionId.open_daysread, PermissionId.open_daysmanage]}>
                  <OpenDaysPage />
                </PermissionRoute>
              }
            />
            <Route
              path="open-days/:periodId"
              element={
                <PermissionRoute anyOf={[PermissionId.open_daysread, PermissionId.open_daysmanage]}>
                  <OpenDayPeriodPage />
                </PermissionRoute>
              }
            />
            <Route
              path="open-days/:periodId/days/:openDayId"
              element={
                <PermissionRoute anyOf={[PermissionId.open_daysread, PermissionId.open_daysmanage]}>
                  <OpenDayDetailPage />
                </PermissionRoute>
              }
            />
            <Route
              path="open-days/:periodId/schedule"
              element={
                <PermissionRoute allOf={[PermissionId.open_daysmanage]}>
                  <OpenDayScheduleRedirect />
                </PermissionRoute>
              }
            />
            <Route
              path="open-days/manage"
              element={
                <PermissionRoute allOf={[PermissionId.open_daysmanage]}>
                  <OpenDayManagementPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage"
              element={
                <PermissionRoute allOf={[PermissionId.signageread]}>
                  <SignageDisplaysPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/displays/:displayId"
              element={
                <PermissionRoute allOf={[PermissionId.signageread]}>
                  <SignageDisplayDetailPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/announcements"
              element={
                <PermissionRoute anyOf={[PermissionId.signageread, PermissionId.signageoverride]}>
                  <SignageAnnouncementsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/content"
              element={
                <PermissionRoute allOf={[PermissionId.signageread]}>
                  <SignageContentPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/scenes/:sceneId"
              element={
                <PermissionRoute allOf={[PermissionId.signageread]}>
                  <SignageSceneEditorPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/playlists/:playlistId"
              element={
                <PermissionRoute allOf={[PermissionId.signageread]}>
                  <SignagePlaylistDetailPage />
                </PermissionRoute>
              }
            />
            <Route
              path="signage/media"
              element={
                <PermissionRoute allOf={[PermissionId.signageread]}>
                  <SignageMediaPage />
                </PermissionRoute>
              }
            />
            <Route path="settings" element={<SettingsRoute />} />
            <Route
              path="settings/managed-devices"
              element={
                <PermissionRoute allOf={[PermissionId.managed_devicesread]}>
                  <ManagedDevicesPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/open-days"
              element={
                <PermissionRoute allOf={[PermissionId.open_daysmanage]}>
                  <OpenDayRequirementsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/session-policies"
              element={
                <PermissionRoute allOf={[PermissionId.session_policiesmanage]}>
                  <SessionPoliciesPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/surveys"
              element={
                <PermissionRoute anyOf={[PermissionId.surveysread, PermissionId.surveysmanage]}>
                  <SurveyAdminPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/laborordnung"
              element={
                <PermissionRoute
                  anyOf={[
                    PermissionId.laborordnungread,
                    PermissionId.laborordnungmanage,
                    PermissionId.laborordnungrequestsread,
                  ]}
                >
                  <LaborordnungPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/local-services"
              element={
                <PermissionRoute allOf={[PermissionId.local_servicesmanage]}>
                  <LocalServicesPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/local-services/:gatewayId"
              element={
                <PermissionRoute allOf={[PermissionId.local_servicesmanage]}>
                  <GatewayDetailPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/oidc"
              element={
                <PermissionRoute allOf={[PermissionId.oidcmanage]}>
                  <OIDCProvidersPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/scim"
              element={
                <PermissionRoute allOf={[PermissionId.scimmanage]}>
                  <SCIMConnectorsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/printer-connectors"
              element={<Navigate to="/machine-logbook/machines?tab=connectors" replace />}
            />
            <Route
              path="settings/visitor-enrollment"
              element={
                <PermissionRoute allOf={[PermissionId.visitor_enrollmentmanage]}>
                  <VisitorEnrollmentSettingsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/mail"
              element={
                <PermissionRoute allOf={[PermissionId.mailmanage]}>
                  <MailSettingsPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/branding-legal"
              element={
                <PermissionRoute allOf={[PermissionId.brandingmanage]}>
                  <BrandingLegalSettingsPage />
                </PermissionRoute>
              }
            />
            <Route path="settings/machine-logbook" element={<Navigate to="/pricing" replace />} />
            <Route
              path="people"
              element={
                <PermissionRoute allOf={[PermissionId.peoplereadall]}>
                  <UsersPage />
                </PermissionRoute>
              }
            />
            {/* The layout hosts the toast stack, so a deletion can confirm after leaving its page. */}
            <Route element={<MachineLogbookLayout />}>
              <Route
                path="sales"
                element={
                  <PermissionRoute anyOf={[PermissionId.ordersread, PermissionId.paymentsread]}>
                    <SalesOverviewPage />
                  </PermissionRoute>
                }
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
                path="orders/:orderId"
                element={
                  <PermissionRoute allOf={[PermissionId.ordersread]}>
                    <OrderDetailPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="orders/:orderId/receipt"
                element={
                  <PermissionRoute allOf={[PermissionId.ordersread, PermissionId.paymentsread]}>
                    <ReceiptPage />
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
                path="pricing"
                element={
                  <PermissionRoute allOf={[PermissionId.pricingread]}>
                    <PricingPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="organizations"
                element={
                  <PermissionRoute allOf={[PermissionId.organizationsread]}>
                    <OrganizationsPage />
                  </PermissionRoute>
                }
              />
              <Route
                path="organizations/:organizationId"
                element={
                  <PermissionRoute allOf={[PermissionId.organizationsread]}>
                    <OrganizationDetailPage />
                  </PermissionRoute>
                }
              />
            </Route>
            <Route
              path="people/staffing"
              element={
                <PermissionRoute allOf={[PermissionId.supervisor_dashboardread]}>
                  <SupervisorStaffingPage />
                </PermissionRoute>
              }
            />
            <Route
              path="people/new"
              element={
                <PermissionRoute allOf={[PermissionId.peoplecreate]}>
                  <UserCreatePage />
                </PermissionRoute>
              }
            />
            <Route
              path="people/:personId"
              element={
                <PermissionRoute allOf={[PermissionId.peoplereadall]}>
                  <UserDetailPage />
                </PermissionRoute>
              }
            />
            <Route path="external-invoicing" element={<Navigate to="/orders?invoice=draft,submitted" replace />} />
            <Route path="external-invoicing/:requestId" element={<ExternalInvoiceRedirect />} />
            <Route
              path="audit-log"
              element={
                <PermissionRoute allOf={[PermissionId.auditread]}>
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
                <PermissionRoute allOf={[PermissionId.rolesread]}>
                  <RolesPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/roles/new"
              element={
                <PermissionRoute allOf={[PermissionId.rolesread, PermissionId.rolesmanage]}>
                  <RolesPage />
                </PermissionRoute>
              }
            />
            <Route
              path="settings/roles/:roleId"
              element={
                <PermissionRoute allOf={[PermissionId.rolesread]}>
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
