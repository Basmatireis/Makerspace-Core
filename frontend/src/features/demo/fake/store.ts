import type {
  BillingParty,
  CurrentUser,
  FilamentSpool,
  AccountPreference,
  GuideProgress,
  InventoryTransaction,
  MachineJob,
  MachineRunDetail,
  Machine,
  Material,
  MaterialType,
  OpenDay,
  OpenDayPeriod,
  OpenDaySeries,
  Order,
  OrderPayment,
  Organization,
  PricingGroup,
  Process,
  Role,
  RolePricingGroup,
  StaffingRules,
} from '../../../api/generated/models';
import { createdDemoId } from './ids';

export type DemoPerson = { id: string; firstName: string; lastName: string };

/** All mutable state of one demo session; discarded when demo mode ends. */
export type DemoStore = {
  user: CurrentUser;
  now: Date;
  /** Counts entities created during the session, for their identifiers. */
  sequence: number;
  /** The last number handed out per display reference prefix (`J`, `ORD`, ...). */
  counters: Record<string, number>;
  people: DemoPerson[];
  organizations: Organization[];
  roles: Role[];
  processes: Process[];
  machines: Machine[];
  materialTypes: MaterialType[];
  materials: Material[];
  spools: FilamentSpool[];
  transactions: InventoryTransaction[];
  runs: MachineRunDetail[];
  jobs: MachineJob[];
  orders: Order[];
  payments: OrderPayment[];
  pricingGroups: PricingGroup[];
  rolePricingGroups: RolePricingGroup[];
  period: OpenDayPeriod;
  openDays: OpenDay[];
  series: OpenDaySeries[];
  staffingRules: StaffingRules;
  guideProgress: GuideProgress[];
  /** Stored interface preferences of the demo account, so demo mode never writes to the real one. */
  accountPreferences: AccountPreference[];
};

export const can = (store: DemoStore, permission: string): boolean =>
  store.user.permissions.includes(permission as never);

export function nextId(store: DemoStore): string {
  store.sequence += 1;
  return createdDemoId(store.sequence);
}

/** A display reference such as `J-0042`, numbered after the sample ones. */
export function nextReference(store: DemoStore, prefix: string, sampleCount: number): string {
  const next = (store.counters[prefix] ?? sampleCount) + 1;
  store.counters[prefix] = next;
  return `${prefix}-${String(next).padStart(4, '0')}`;
}

export const nowIso = (store: DemoStore) => store.now.toISOString();
export const hoursAgo = (store: DemoStore, hours: number) =>
  new Date(store.now.getTime() - hours * 3_600_000).toISOString();
export const daysFromNow = (store: DemoStore, days: number, hour = 16, minute = 0) => {
  const date = new Date(store.now);
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hour, minute, 0, 0);
  return date.toISOString();
};

export const toCents = (amount: string | number): number => Math.round(Number(amount) * 100);
export const money = (cents: number): string => (cents / 100).toFixed(2);
export const decimal = (value: number, digits = 3): string => value.toFixed(digits);

export const personName = (person: Pick<DemoPerson, 'firstName' | 'lastName'>) =>
  `${person.firstName} ${person.lastName}`;

export function billingParty(store: DemoStore, kind: string, id: string): BillingParty | undefined {
  if (kind === 'organization') {
    const organization = store.organizations.find((item) => item.id === id);
    return organization && organizationParty(organization);
  }
  const person = store.people.find((item) => item.id === id);
  return person && personParty(person);
}

export const personParty = (person: DemoPerson): BillingParty => ({
  kind: 'person',
  id: person.id,
  displayName: personName(person),
  pricingGroup: null,
  pricingGroupAssignmentVersion: 0,
});

export const organizationParty = (organization: Organization): BillingParty => ({
  kind: 'organization',
  id: organization.id,
  displayName: organization.name,
  organizationKind: organization.kind,
  pricingGroup: organization.pricingGroup ?? null,
  pricingGroupAssignmentVersion: organization.pricingGroupAssignmentVersion,
});
