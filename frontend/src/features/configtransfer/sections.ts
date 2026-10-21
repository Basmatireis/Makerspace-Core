import type { ConfigurationSection, CurrentUser } from '../../api/generated/models';
import { hasPermission, PermissionId, type PermissionIdType } from '../auth/permissions';

export type SectionDefinition = {
  key: ConfigurationSection;
  label: string;
  description: string;
  read: PermissionIdType[];
  manage: PermissionIdType[];
};

// Mirrors the section registry in backend/internal/configtransfer (import order). The backend enforces these
// permissions; the UI only hides sections the account cannot use.
export const sectionDefinitions: SectionDefinition[] = [
  {
    key: 'deviceTypes',
    label: 'Device types',
    description: 'Managed device types; devices and their credentials stay.',
    read: [PermissionId.managed_devicesread],
    manage: [PermissionId.managed_devicesmanage],
  },
  {
    key: 'sessionPolicies',
    label: 'Session policies',
    description: 'Idle limits, lifetimes and destinations.',
    read: [PermissionId.managed_devicesread],
    manage: [PermissionId.session_policiesmanage],
  },
  {
    key: 'roles',
    label: 'Roles & permissions',
    description: 'Configurable roles; the master role is never included.',
    read: [PermissionId.rolesread],
    manage: [PermissionId.rolesmanage],
  },
  {
    key: 'machineTypes',
    label: 'Machine types',
    description: 'Machine types and their processes.',
    read: [PermissionId.machinesread],
    manage: [PermissionId.machinesmanage],
  },
  {
    key: 'materialTypes',
    label: 'Material types',
    description: 'Filament, consumable and part categories.',
    read: [PermissionId.inventoryread],
    manage: [PermissionId.inventorymanage],
  },
  {
    key: 'machines',
    label: 'Machines & printer setup',
    description: 'Machines with printer model, input units and slots; no jobs, runs or connectors.',
    read: [PermissionId.machinesread],
    manage: [PermissionId.machinesmanage],
  },
  {
    key: 'inventoryArticles',
    label: 'Inventory articles',
    description: 'Article definitions; no stock, ledger or spools.',
    read: [PermissionId.inventoryread],
    manage: [PermissionId.inventorymanage],
  },
  {
    key: 'pricing',
    label: 'Pricing',
    description: 'Pricing groups, rates and role pricing groups.',
    read: [PermissionId.pricingread],
    manage: [PermissionId.pricingmanage],
  },
  {
    key: 'openDayRequirements',
    label: 'Open day requirements',
    description: 'Open days per semester and trainee promotion.',
    read: [PermissionId.open_daysread],
    manage: [PermissionId.open_daysmanage],
  },
  {
    key: 'visitorEnrollment',
    label: 'Visitor enrollment',
    description: 'Initial role, terminals and authentication methods.',
    read: [PermissionId.visitor_enrollmentmanage],
    manage: [PermissionId.visitor_enrollmentmanage],
  },
  {
    key: 'branding',
    label: 'Branding & legal',
    description: 'Identity, colors, legal pages and custom assets.',
    read: [PermissionId.brandingmanage],
    manage: [PermissionId.brandingmanage],
  },
  {
    key: 'labRules',
    label: 'Lab Rules',
    description: 'The current and upcoming published versions with their PDFs.',
    read: [PermissionId.laborordnungread],
    manage: [PermissionId.laborordnungmanage],
  },
  {
    key: 'surveys',
    label: 'Surveys',
    description: 'Survey definitions; never responses.',
    read: [PermissionId.surveysread],
    manage: [PermissionId.surveysmanage],
  },
  {
    key: 'mail',
    label: 'Email delivery',
    description: 'SMTP server and sender; never the password.',
    read: [PermissionId.mailmanage],
    manage: [PermissionId.mailmanage],
  },
];

export function sectionLabel(key: ConfigurationSection): string {
  return sectionDefinitions.find((section) => section.key === key)?.label ?? key;
}

export function canExportSection(user: CurrentUser, section: SectionDefinition): boolean {
  return section.read.every((permission) => hasPermission(user, permission));
}

export function canImportSection(user: CurrentUser, section: SectionDefinition): boolean {
  return canExportSection(user, section) && section.manage.every((permission) => hasPermission(user, permission));
}

export const configurationFileFormat = 'makerspace-core-config';

export type ConfigurationFileSummary = {
  sections: ConfigurationSection[];
  appVersion: string;
  exportedAt?: string;
};

// readConfigurationFile checks the envelope locally so the import can offer only the sections the file contains;
// the backend validates the whole file again.
export async function readConfigurationFile(file: File): Promise<ConfigurationFileSummary> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) throw new Error('The file is not a configuration file.');
  const envelope = parsed as { format?: unknown; version?: unknown; appVersion?: unknown; exportedAt?: unknown };
  const sections = (parsed as { sections?: unknown }).sections;
  if (envelope.format !== configurationFileFormat || typeof sections !== 'object' || sections === null) {
    throw new Error('The file is not a Makerspace Core configuration file.');
  }
  if (envelope.version !== 1) throw new Error('This configuration file version is not supported.');
  const known = new Set<string>(sectionDefinitions.map((section) => section.key));
  return {
    sections: Object.keys(sections).filter((key): key is ConfigurationSection => known.has(key)),
    appVersion: typeof envelope.appVersion === 'string' ? envelope.appVersion : '',
    exportedAt: typeof envelope.exportedAt === 'string' ? envelope.exportedAt : undefined,
  };
}
