import {
  Calendar,
  Devices,
  Document,
  Education,
  Email,
  Group,
  IbmCloudKeyProtect,
  Migrate,
  PaintBrush,
  QuestionAnswering,
  Receipt,
  UserMultiple,
  VideoChat,
} from '@carbon/icons-react';
import type { ComponentType } from 'react';
import type { CurrentUser } from '../../api/generated/models';
import type { PermissionId as PermissionIdType } from '../../api/generated/models';
import { hasAnyPermission, PermissionId } from '../auth/permissions';

export type SettingsGroupId = 'access' | 'lab' | 'communication' | 'sales' | 'local-services' | 'data';

export type SettingsPageId =
  | 'roles'
  | 'single-sign-on'
  | 'devices-sessions'
  | 'open-days'
  | 'trainings'
  | 'laborordnung'
  | 'visitor-enrollment'
  | 'surveys'
  | 'mail'
  | 'branding-legal'
  | 'invoicing'
  | 'local-services'
  | 'configuration-transfer';

export type SettingsGroup = {
  id: SettingsGroupId;
  title: string;
  description: string;
};

export type SettingsItem = {
  id: SettingsPageId;
  group: SettingsGroupId;
  title: string;
  description: string;
  path: string;
  icon: ComponentType<{ size?: number | string }>;
  /** Any of these permissions makes the screen (or one of its tabs) usable. */
  permissions: readonly PermissionIdType[];
};

export const settingsGroups: readonly SettingsGroup[] = [
  {
    id: 'access',
    title: 'Access & identity',
    description: 'Who can sign in, with which roles, and from which devices.',
  },
  {
    id: 'lab',
    title: 'Lab operations',
    description: 'Open day staffing, trainings, lab rules, visitor intake and feedback.',
  },
  {
    id: 'communication',
    title: 'Communication & appearance',
    description: 'How Core talks to people and how it looks.',
  },
  { id: 'sales', title: 'Sales & invoicing', description: 'Hand-over of approved invoice requests.' },
  {
    id: 'local-services',
    title: 'Local services',
    description: 'Software that runs in the makerspace network next to Core.',
  },
  { id: 'data', title: 'Data', description: 'Move configuration between instances.' },
];

export const settingsItems: readonly SettingsItem[] = [
  {
    id: 'roles',
    group: 'access',
    title: 'Roles & Permissions',
    description: 'Configure reusable permission sets for accounts.',
    path: '/settings/roles',
    icon: Group,
    permissions: [PermissionId.rolesread],
  },
  {
    id: 'single-sign-on',
    group: 'access',
    title: 'Single sign-on',
    description: 'OpenID Connect providers and SCIM provisioning.',
    path: '/settings/single-sign-on',
    icon: IbmCloudKeyProtect,
    permissions: [PermissionId.oidcmanage, PermissionId.scimmanage],
  },
  {
    id: 'devices-sessions',
    group: 'access',
    title: 'Devices & sessions',
    description: 'Session limits and trusted kiosks.',
    path: '/settings/devices-sessions',
    icon: Devices,
    permissions: [PermissionId.session_policiesmanage, PermissionId.managed_devicesread],
  },
  {
    id: 'open-days',
    group: 'lab',
    title: 'Open days & staffing',
    description: 'How many open days supervisors and trainees staff per semester.',
    path: '/settings/open-days',
    icon: Calendar,
    permissions: [PermissionId.open_daysmanage],
  },
  {
    id: 'trainings',
    group: 'lab',
    title: 'Trainings & competencies',
    description: 'Trainings people are recorded for and the competencies open days show.',
    path: '/settings/trainings',
    icon: Education,
    permissions: [PermissionId.trainingsmanage],
  },
  {
    id: 'laborordnung',
    group: 'lab',
    title: 'Lab Rules',
    description: 'Publish PDFs and verify physical evidence.',
    path: '/settings/laborordnung',
    icon: Document,
    permissions: [
      PermissionId.laborordnungread,
      PermissionId.laborordnungmanage,
      PermissionId.laborordnungrequestsread,
    ],
  },
  {
    id: 'visitor-enrollment',
    group: 'lab',
    title: 'Visitor enrollment',
    description: 'Approved kiosks, the initial role and authentication methods.',
    path: '/settings/visitor-enrollment',
    icon: UserMultiple,
    permissions: [PermissionId.visitor_enrollmentmanage],
  },
  {
    id: 'surveys',
    group: 'lab',
    title: 'Surveys',
    description: 'Build surveys and configure post-visit delivery.',
    path: '/settings/surveys',
    icon: QuestionAnswering,
    permissions: [PermissionId.surveysread, PermissionId.surveysmanage],
  },
  {
    id: 'mail',
    group: 'communication',
    title: 'Email delivery',
    description: 'SMTP, sender identity and recovery-link delivery.',
    path: '/settings/mail',
    icon: Email,
    permissions: [PermissionId.mailmanage],
  },
  {
    id: 'branding-legal',
    group: 'communication',
    title: 'Branding & legal',
    description: 'Organization identity, colors, assets and public legal documents.',
    path: '/settings/branding-legal',
    icon: PaintBrush,
    permissions: [PermissionId.brandingmanage],
  },
  {
    id: 'invoicing',
    group: 'sales',
    title: 'Invoicing',
    description: 'The mail and PDF that hand approved invoice requests to wiRef.',
    path: '/settings/invoicing',
    icon: Receipt,
    permissions: [PermissionId.invoicingsettingsmanage],
  },
  {
    id: 'local-services',
    group: 'local-services',
    title: 'Printer connectors & streaming gateways',
    description: 'Connectors, gateways and their versions and updates.',
    path: '/settings/local-services',
    icon: VideoChat,
    permissions: [PermissionId.local_servicesmanage, PermissionId.printer_connectorsread],
  },
  {
    id: 'configuration-transfer',
    group: 'data',
    title: 'Export & import',
    description: 'Move roles, machines, pricing and settings between instances as a file.',
    path: '/settings/configuration-transfer',
    icon: Migrate,
    permissions: [PermissionId.configurationexport, PermissionId.configurationimport],
  },
];

export function settingsItem(id: SettingsPageId): SettingsItem {
  const item = settingsItems.find((candidate) => candidate.id === id);
  if (!item) throw new Error(`Unknown settings page ${id}`);
  return item;
}

export function settingsGroup(id: SettingsGroupId): SettingsGroup {
  const group = settingsGroups.find((candidate) => candidate.id === id);
  if (!group) throw new Error(`Unknown settings group ${id}`);
  return group;
}

export function visibleSettingsItems(currentUser: CurrentUser): SettingsItem[] {
  return settingsItems.filter((item) => hasAnyPermission(currentUser, item.permissions));
}
