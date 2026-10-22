import { lazy } from 'react';

export const ResetPasswordPage = lazy(() =>
  import('../features/auth/ResetPasswordPage').then(({ ResetPasswordPage }) => ({ default: ResetPasswordPage })),
);
export const InvitationPage = lazy(() =>
  import('../features/auth/ResetPasswordPage').then(({ InvitationPage }) => ({ default: InvitationPage })),
);
export const PINEnrollmentPage = lazy(() =>
  import('../features/auth/ResetPasswordPage').then(({ PINEnrollmentPage }) => ({ default: PINEnrollmentPage })),
);
export const EmailVerificationPage = lazy(() =>
  import('../features/auth/ResetPasswordPage').then(({ EmailVerificationPage }) => ({
    default: EmailVerificationPage,
  })),
);
export const VisitorEnrollmentPage = lazy(() =>
  import('../features/visitor/VisitorEnrollmentPage').then(({ VisitorEnrollmentPage }) => ({
    default: VisitorEnrollmentPage,
  })),
);
export const LegalPage = lazy(() =>
  import('../features/branding/LegalPage').then(({ LegalPage }) => ({ default: LegalPage })),
);
export const ProfilePage = lazy(() =>
  import('../features/profile/ProfilePage').then(({ ProfilePage }) => ({ default: ProfilePage })),
);
export const SalesOverviewPage = lazy(() =>
  import('../features/orders/SalesOverviewPage').then(({ SalesOverviewPage }) => ({ default: SalesOverviewPage })),
);
export const OrdersPage = lazy(() =>
  import('../features/orders/OrdersPage').then(({ OrdersPage }) => ({ default: OrdersPage })),
);
export const OrderDetailPage = lazy(() =>
  import('../features/orders/OrderDetailPage').then(({ OrderDetailPage }) => ({ default: OrderDetailPage })),
);
export const ReceiptPage = lazy(() =>
  import('../features/orders/ReceiptPage').then(({ ReceiptPage }) => ({ default: ReceiptPage })),
);
export const PaymentsPage = lazy(() =>
  import('../features/orders/PaymentsPage').then(({ PaymentsPage }) => ({ default: PaymentsPage })),
);
export const PaymentDetailPage = lazy(() =>
  import('../features/orders/PaymentDetailPage').then(({ PaymentDetailPage }) => ({ default: PaymentDetailPage })),
);
export const PricingPage = lazy(() =>
  import('../features/pricing/PricingPage').then(({ PricingPage }) => ({ default: PricingPage })),
);
export const MachineLogbookLayout = lazy(() =>
  import('../features/machinelogbook/shared/MachineLogbookLayout').then(({ MachineLogbookLayout }) => ({
    default: MachineLogbookLayout,
  })),
);
export const MachineLogbookOverviewPage = lazy(() =>
  import('../features/machinelogbook/OverviewPage').then(({ MachineLogbookOverviewPage }) => ({
    default: MachineLogbookOverviewPage,
  })),
);
export const JobsPage = lazy(() =>
  import('../features/machinelogbook/JobsPage').then(({ JobsPage }) => ({ default: JobsPage })),
);
export const JobDetailPage = lazy(() =>
  import('../features/machinelogbook/JobDetailPage').then(({ JobDetailPage }) => ({ default: JobDetailPage })),
);
export const RunDetailPage = lazy(() =>
  import('../features/machinelogbook/RunDetailPage').then(({ RunDetailPage }) => ({ default: RunDetailPage })),
);
export const InventoryPage = lazy(() =>
  import('../features/machinelogbook/InventoryPage').then(({ InventoryPage }) => ({ default: InventoryPage })),
);
export const MaterialDetailPage = lazy(() =>
  import('../features/machinelogbook/MaterialDetailPage').then(({ MaterialDetailPage }) => ({
    default: MaterialDetailPage,
  })),
);
export const FilamentSpoolDetailPage = lazy(() =>
  import('../features/machinelogbook/FilamentSpoolDetailPage').then(({ FilamentSpoolDetailPage }) => ({
    default: FilamentSpoolDetailPage,
  })),
);
export const MachinesPage = lazy(() =>
  import('../features/machinelogbook/MachinesPage').then(({ MachinesPage }) => ({ default: MachinesPage })),
);
export const MachineDetailPage = lazy(() =>
  import('../features/machinelogbook/MachineDetailPage').then(({ MachineDetailPage }) => ({
    default: MachineDetailPage,
  })),
);
export const StatisticsPage = lazy(() =>
  import('../features/machinelogbook/StatisticsPage').then(({ StatisticsPage }) => ({ default: StatisticsPage })),
);
export const SignageDisplaysPage = lazy(() =>
  import('../features/signage/DisplaysPage').then(({ DisplaysPage }) => ({ default: DisplaysPage })),
);
export const SignageDisplayDetailPage = lazy(() =>
  import('../features/signage/DisplayDetailPage').then(({ DisplayDetailPage }) => ({ default: DisplayDetailPage })),
);
export const SignageAnnouncementsPage = lazy(() =>
  import('../features/signage/AnnouncementsPage').then(({ AnnouncementsPage }) => ({ default: AnnouncementsPage })),
);
export const SignageContentPage = lazy(() =>
  import('../features/signage/ContentPage').then(({ ContentPage }) => ({ default: ContentPage })),
);
export const SignageSceneEditorPage = lazy(() =>
  import('../features/signage/SceneEditorPage').then(({ SceneEditorPage }) => ({ default: SceneEditorPage })),
);
export const SignagePlaylistDetailPage = lazy(() =>
  import('../features/signage/PlaylistDetailPage').then(({ PlaylistDetailPage }) => ({ default: PlaylistDetailPage })),
);
export const SignageCustomLayoutEditorPage = lazy(() =>
  import('../features/signage/CustomLayoutEditorPage').then(({ CustomLayoutEditorPage }) => ({
    default: CustomLayoutEditorPage,
  })),
);
export const SignageMediaPage = lazy(() =>
  import('../features/signage/MediaPage').then(({ MediaPage }) => ({ default: MediaPage })),
);
export const OpenDaysPage = lazy(() =>
  import('../features/opendays/OpenDaysPage').then(({ OpenDaysPage }) => ({ default: OpenDaysPage })),
);
export const OpenDayPeriodPage = lazy(() =>
  import('../features/opendays/OpenDayPeriodPage').then(({ OpenDayPeriodPage }) => ({ default: OpenDayPeriodPage })),
);
export const OpenDayDetailPage = lazy(() =>
  import('../features/opendays/OpenDayDetailPage').then(({ OpenDayDetailPage }) => ({ default: OpenDayDetailPage })),
);
export const OpenDayManagementPage = lazy(() =>
  import('../features/opendays/OpenDayManagementPage').then(({ OpenDayManagementPage }) => ({
    default: OpenDayManagementPage,
  })),
);
export const SettingsPage = lazy(() =>
  import('../features/settings/SettingsPage').then(({ SettingsPage }) => ({ default: SettingsPage })),
);
export const SingleSignOnPage = lazy(() =>
  import('../features/settings/SingleSignOnPage').then(({ SingleSignOnPage }) => ({ default: SingleSignOnPage })),
);
export const DevicesSessionsPage = lazy(() =>
  import('../features/settings/DevicesSessionsPage').then(({ DevicesSessionsPage }) => ({
    default: DevicesSessionsPage,
  })),
);
export const ConfigurationTransferPage = lazy(() =>
  import('../features/configtransfer/ConfigurationTransferPage').then(({ ConfigurationTransferPage }) => ({
    default: ConfigurationTransferPage,
  })),
);
export const LocalServicesPage = lazy(() =>
  import('../features/localservices/LocalServicesPage').then(({ LocalServicesPage }) => ({
    default: LocalServicesPage,
  })),
);
export const GatewayDetailPage = lazy(() =>
  import('../features/localservices/GatewayDetailPage').then(({ GatewayDetailPage }) => ({
    default: GatewayDetailPage,
  })),
);
export const LaborordnungPage = lazy(() =>
  import('../features/laborordnung/LaborordnungPage').then(({ LaborordnungPage }) => ({ default: LaborordnungPage })),
);
export const VisitorEnrollmentSettingsPage = lazy(() =>
  import('../features/visitor/VisitorEnrollmentSettingsPage').then(({ VisitorEnrollmentSettingsPage }) => ({
    default: VisitorEnrollmentSettingsPage,
  })),
);
export const InvoicingSettingsPage = lazy(() =>
  import('../features/invoicing/InvoicingSettingsPage').then(({ InvoicingSettingsPage }) => ({
    default: InvoicingSettingsPage,
  })),
);
export const MailSettingsPage = lazy(() =>
  import('../features/mail/MailSettingsPage').then(({ MailSettingsPage }) => ({ default: MailSettingsPage })),
);
export const BrandingLegalSettingsPage = lazy(() =>
  import('../features/branding/BrandingLegalSettingsPage').then(({ BrandingLegalSettingsPage }) => ({
    default: BrandingLegalSettingsPage,
  })),
);
export const OrganizationsPage = lazy(() =>
  import('../features/organizations/OrganizationsPage').then(({ OrganizationsPage }) => ({
    default: OrganizationsPage,
  })),
);
export const OrganizationDetailPage = lazy(() =>
  import('../features/organizations/OrganizationDetailPage').then(({ OrganizationDetailPage }) => ({
    default: OrganizationDetailPage,
  })),
);
export const UsersPage = lazy(() =>
  import('../features/users/UsersPage').then(({ UsersPage }) => ({ default: UsersPage })),
);
export const SupervisorStaffingPage = lazy(() =>
  import('../features/users/SupervisorStaffingPage').then(({ SupervisorStaffingPage }) => ({
    default: SupervisorStaffingPage,
  })),
);
export const UserCreatePage = lazy(() =>
  import('../features/users/UserCreatePage').then(({ UserCreatePage }) => ({ default: UserCreatePage })),
);
export const UserDetailPage = lazy(() =>
  import('../features/users/UserDetailPage').then(({ UserDetailPage }) => ({ default: UserDetailPage })),
);
export const ActivityPage = lazy(() =>
  import('../features/audit/ActivityPage').then(({ ActivityPage }) => ({ default: ActivityPage })),
);
export const RolesPage = lazy(() =>
  import('../features/roles/RolesPage').then(({ RolesPage }) => ({ default: RolesPage })),
);
export const EventsPage = lazy(() =>
  import('../features/events/EventsPage').then(({ EventsPage }) => ({ default: EventsPage })),
);
export const EventCreatePage = lazy(() =>
  import('../features/events/EventCreatePage').then(({ EventCreatePage }) => ({ default: EventCreatePage })),
);
export const EventDetailPage = lazy(() =>
  import('../features/events/EventDetailPage').then(({ EventDetailPage }) => ({ default: EventDetailPage })),
);
export const PublicEventPage = lazy(() =>
  import('../features/events/PublicEventPage').then(({ PublicEventPage }) => ({ default: PublicEventPage })),
);
export const EventSignupManagementPage = lazy(() =>
  import('../features/events/EventSignupManagementPage').then(({ EventSignupManagementPage }) => ({
    default: EventSignupManagementPage,
  })),
);
export const VisitorTerminalPage = lazy(() =>
  import('../features/terminal/VisitorTerminalPage').then(({ VisitorTerminalPage }) => ({
    default: VisitorTerminalPage,
  })),
);
export const PublicSurveyPage = lazy(() =>
  import('../features/surveys/PublicSurveyPage').then(({ PublicSurveyPage }) => ({ default: PublicSurveyPage })),
);
export const AttendancePage = lazy(() =>
  import('../features/attendance/AttendancePage').then(({ AttendancePage }) => ({ default: AttendancePage })),
);
export const SurveyAdminPage = lazy(() =>
  import('../features/surveys/SurveyAdminPage').then(({ SurveyAdminPage }) => ({ default: SurveyAdminPage })),
);
export const DashboardPage = lazy(() =>
  import('../features/dashboard/DashboardPage').then(({ DashboardPage }) => ({ default: DashboardPage })),
);
export const OpenDayRequirementsPage = lazy(() =>
  import('../features/opendays/OpenDayRequirementsPage').then(({ OpenDayRequirementsPage }) => ({
    default: OpenDayRequirementsPage,
  })),
);
