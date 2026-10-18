import type { BillingParty, Material, MachineType, PricingRule } from '../types';
import type { CatalogItem, OrganizationRecord } from './types';
import { formatAmount, formatQuantity, round2 } from './format';

// Stand-in for the backend pricing service (groups, rules, party assignments), after machinelogbook/catalog.go: a pricing group has
// one rate per selector. A selector is either "machine runtime of a machine type" (per hour) or "material of a category in a unit".
// A job is priced at capture time with a group that is resolved in this order: the group set on the job > the group of the organization
// (organization customers) > the group mapped to the account's highest-priority role > the default group. A missing rate leaves the price
// incomplete instead of guessing.

export type RateUnit = 'h' | 'g' | 'ml' | 'm2' | 'piece';
export type PricingGroup = { id: string; name: string; description: string; isDefault: boolean; active: boolean };
export type RateRule = { id: string; groupId: string; kind: 'machine_runtime' | 'material'; machineTypeId: string | null; category: string | null; unit: RateUnit; rate: number };
/** [proposed] Maps account roles to pricing groups. Role id to group name; a role without an entry follows the default group. */
export type PricingConfig = { groups: PricingGroup[]; rules: RateRule[]; roleGroups: Record<string, string> };

/** Account roles in priority order: when an account has several roles, the first one in this list that is mapped decides. */
export const accountRoles: { id: string; label: string }[] = [
  { id: 'staff', label: 'Staff' },
  { id: 'team_member', label: 'Student team member' },
  { id: 'student', label: 'Student' },
  { id: 'member', label: 'Makerspace member' },
];
export const roleLabel = (id: string) => accountRoles.find((role) => role.id === id)?.label ?? id;

/** One row of the rates matrix. */
export type RateSelector = { key: string; kind: RateRule['kind']; label: string; machineTypeId: string | null; category: string | null; unit: RateUnit };

export const unitLabel = (unit: string) => unit === 'm2' ? 'm²' : unit === 'h' ? 'hour' : unit === 'piece' || unit === 'pcs' ? 'piece' : unit;
const perUnit = (unit: string) => unit === 'h' ? 'h' : unitLabel(unit);

const selectorKey = (kind: RateRule['kind'], machineTypeId: string | null, category: string | null, unit: string) => kind === 'machine_runtime' ? `machine:${machineTypeId}` : `material:${(category ?? '').toLowerCase()}:${unit === 'pcs' ? 'piece' : unit}`;
export const ruleKey = (rule: RateRule) => selectorKey(rule.kind, rule.machineTypeId, rule.category, rule.unit);

/** The rows of the matrix: the runtime of every active machine type and every material category and unit in use. */
export function rateSelectors(machineTypes: MachineType[], materials: Pick<Material, 'category' | 'unit'>[]): RateSelector[] {
  const machine = machineTypes.filter((type) => type.active).map((type): RateSelector => ({ key: selectorKey('machine_runtime', type.id, null, 'h'), kind: 'machine_runtime', label: `${type.name} runtime`, machineTypeId: type.id, category: null, unit: 'h' }));
  const seen = new Set<string>();
  const material: RateSelector[] = [];
  for (const item of materials) {
    const unit = (item.unit === 'pcs' ? 'piece' : item.unit) as RateUnit;
    const key = selectorKey('material', null, item.category, unit);
    if (seen.has(key)) continue;
    seen.add(key);
    material.push({ key, kind: 'material', label: `${item.category} material`, machineTypeId: null, category: item.category, unit });
  }
  return [...machine, ...material.sort((a, b) => a.label.localeCompare(b.label))];
}

const GROUP_SEED: { id: string; name: string; description: string; isDefault: boolean; hour: number; gram: number; ml: number; m2: number }[] = [
  { id: 'pg-external', name: 'External', description: 'Customers without a membership. Applies when nobody is assigned a group.', isDefault: true, hour: 6, gram: 0.08, ml: 0.24, m2: 12 },
  { id: 'pg-students', name: 'Students', description: 'Enrolled students at partner universities.', isDefault: false, hour: 2, gram: 0.04, ml: 0.12, m2: 12 },
  { id: 'pg-staff', name: 'Staff', description: 'Employees of partner institutions.', isDefault: false, hour: 2, gram: 0.04, ml: 0.12, m2: 12 },
  { id: 'pg-teams', name: 'Student teams', description: 'Registered student projects such as racing and robotics teams.', isDefault: false, hour: 2, gram: 0.04, ml: 0.12, m2: 12 },
  { id: 'pg-institutes', name: 'Institutes', description: 'Institutes and labs billed by invoice.', isDefault: false, hour: 2, gram: 0.04, ml: 0.12, m2: 12 },
];
/** Rates that are deliberately not set in the seed, so the Pricing page can show the "missing rate" warning. No seeded job depends on them. */
const GAPS = new Set(['pg-teams|machine:type-sla', 'pg-teams|material:resin:ml', 'pg-institutes|machine:type-cnc']);
const SEED_TYPES = ['type-fdm', 'type-sla', 'type-laser', 'type-cnc'];

export function defaultPricingConfig(): PricingConfig {
  const rules: RateRule[] = [];
  for (const group of GROUP_SEED) {
    const add = (rule: Omit<RateRule, 'id' | 'groupId'>) => {
      if (GAPS.has(`${group.id}|${ruleKey({ ...rule, id: '', groupId: group.id })}`)) return;
      rules.push({ ...rule, id: `pr-${group.id}-${rules.length}`, groupId: group.id });
    };
    for (const type of SEED_TYPES) add({ kind: 'machine_runtime', machineTypeId: type, category: null, unit: 'h', rate: group.hour });
    add({ kind: 'material', machineTypeId: null, category: 'Filament', unit: 'g', rate: group.gram });
    add({ kind: 'material', machineTypeId: null, category: 'Resin', unit: 'ml', rate: group.ml });
    add({ kind: 'material', machineTypeId: null, category: 'Sheet', unit: 'm2', rate: group.m2 });
  }
  return {
    groups: GROUP_SEED.map(({ id, name, description, isDefault }) => ({ id, name, description, isDefault, active: true })), rules,
    // 'member' is deliberately not mapped, so ordinary members and accounts without a role fall back to the default group.
    roleGroups: { staff: 'Staff', team_member: 'Student teams', student: 'Students' },
  };
}

let live: PricingConfig = defaultPricingConfig();
let liveOrgs: OrganizationRecord[] = [];
/** The store publishes its pricing and organizations here, so every quote (job forms, repricing, seed replay) uses what is configured now. */
export const setLivePricing = (config: PricingConfig, organizations: OrganizationRecord[] = liveOrgs) => { live = config; liveOrgs = organizations; };
export const livePricing = () => live;
export const liveOrganizations = () => liveOrgs;

export const defaultGroupOf = (config: PricingConfig) => config.groups.find((group) => group.isDefault && group.active) ?? config.groups.find((group) => group.active) ?? config.groups[0];
export const defaultPricingGroup = defaultGroupOf(live).name;
const activeGroup = (config: PricingConfig, name: string | null | undefined) => name ? config.groups.find((group) => group.name === name && group.active) : undefined;

export type GroupResolution = { group: PricingGroup; /** In words, e.g. "via role Student". */ reason: string };

/**
 * The group that prices a customer: set on the job > organization group > the group of the highest-priority mapped role > default.
 * An inactive or missing group is skipped, so a deactivated group never prices anything.
 */
export function resolveGroup(config: PricingConfig, organizations: OrganizationRecord[], party: Pick<BillingParty, 'kind' | 'id' | 'roles'> | null | undefined, explicit?: string | null): GroupResolution {
  const fallback = defaultGroupOf(config);
  const set = activeGroup(config, explicit);
  if (set) return { group: set, reason: 'set on the job' };
  if (party?.kind === 'organization') {
    const organization = organizations.find((item) => item.id === party.id);
    const group = activeGroup(config, organization?.pricingGroup);
    if (group) return { group, reason: 'via the organization' };
    return { group: fallback, reason: 'default group, the organization has none' };
  }
  const roles = party?.roles ?? [];
  for (const role of accountRoles.filter((item) => roles.includes(item.id))) {
    const group = activeGroup(config, config.roleGroups[role.id]);
    if (group) return { group, reason: `via role ${role.label}` };
  }
  return { group: fallback, reason: roles.length ? 'default group, no role is mapped' : 'default group, the account has no role' };
}

export const rateOf = (config: PricingConfig, groupId: string, selector: Pick<RateSelector, 'key'>) => config.rules.find((rule) => rule.groupId === groupId && ruleKey(rule) === selector.key) ?? null;

/** Rates that are missing: every active group against every selector. */
export function pricingGaps(config: PricingConfig, selectors: RateSelector[]) {
  return config.groups.filter((group) => group.active).flatMap((group) => selectors.filter((selector) => !rateOf(config, group.id, selector)).map((selector) => ({ group, selector })));
}

export type QuoteInput = {
  group: string; durationSeconds: number; machineTypeId?: string | null;
  usages: { materialName: string; unit: string; quantity: number; ownership: 'makerspace' | 'external'; category?: string | null }[];
};
export type QuoteLine = { key: string; label: string; detail: string; amount: number; missing: boolean };
export type Quote = { lines: QuoteLine[]; total: number; rules: PricingRule[]; /** Plain-language list of rates that are missing; empty when the price is complete. */ missing: string[]; complete: boolean };

/** Machine time at the group's rate for the machine type plus makerspace-owned material. Customer-owned material is not charged. */
export function quoteJob({ group, durationSeconds, machineTypeId, usages }: QuoteInput, config: PricingConfig = live): Quote {
  const found = config.groups.find((item) => item.name === group) ?? defaultGroupOf(config);
  const rules = config.rules.filter((rule) => rule.groupId === found.id);
  const hours = durationSeconds / 3600;
  const missing: string[] = [];
  const lines: QuoteLine[] = [];
  const snapshot: PricingRule[] = [];

  const machineRule = machineTypeId ? rules.find((rule) => rule.kind === 'machine_runtime' && rule.machineTypeId === machineTypeId) : rules.find((rule) => rule.kind === 'machine_runtime');
  if (machineRule) {
    lines.push({ key: 'machine', label: 'Machine time', detail: `${formatQuantity(Math.round(hours * 100) / 100)} h × ${formatAmount(machineRule.rate)} €/h`, amount: round2(hours * machineRule.rate), missing: false });
    snapshot.push({ label: 'Machine time', rate: machineRule.rate.toFixed(2), unit: 'h', missing: false });
  } else {
    missing.push(`machine time in ${found.name}`);
    lines.push({ key: 'machine', label: 'Machine time', detail: `No rate for this machine type in ${found.name}`, amount: 0, missing: true });
    snapshot.push({ label: 'Machine time', rate: '—', unit: 'h', missing: true });
  }
  usages.forEach((usage, index) => {
    const unit = usage.unit === 'pcs' ? 'piece' : usage.unit;
    if (usage.ownership === 'external') { lines.push({ key: `u${index}`, label: usage.materialName || 'Customer material', detail: 'Customer’s own material, not charged', amount: 0, missing: false }); return; }
    if (!(usage.quantity > 0)) return;
    const rule = rules.find((item) => item.kind === 'material' && item.unit === unit && (!usage.category || (item.category ?? '').toLowerCase() === usage.category.toLowerCase()));
    const label = usage.materialName || usage.category || 'Material';
    if (rule) {
      lines.push({ key: `u${index}`, label, detail: `${formatQuantity(usage.quantity)} ${unitLabel(unit)} × ${formatAmount(rule.rate)} €/${unitLabel(unit)}`, amount: round2(usage.quantity * rule.rate), missing: false });
      snapshot.push({ label: rule.category ?? label, rate: rule.rate.toFixed(2), unit, missing: false });
    } else {
      missing.push(`${usage.category ?? label} per ${unitLabel(unit)} in ${found.name}`);
      lines.push({ key: `u${index}`, label, detail: `No rate for ${usage.category ?? 'this material'} per ${unitLabel(unit)} in ${found.name}`, amount: 0, missing: true });
      snapshot.push({ label: usage.category ?? label, rate: '—', unit, missing: true });
    }
  });
  const deduped = snapshot.filter((rule, index) => snapshot.findIndex((other) => other.label === rule.label && other.unit === rule.unit) === index);
  return { lines, total: round2(lines.reduce((sum, line) => sum + line.amount, 0)), rules: deduped, missing, complete: missing.length === 0 };
}

export { perUnit };

/** [proposed] Sale catalog. The real backend only has free-text manual items. */
export const catalogItems: CatalogItem[] = [
  { id: 'cat-pla-g', name: 'PLA filament sold loose', unit: 'g', unitPrice: 0.05, category: 'Filament' },
  { id: 'cat-petg-g', name: 'PETG filament sold loose', unit: 'g', unitPrice: 0.06, category: 'Filament' },
  { id: 'cat-spool-pla', name: 'PLA spool 1 kg, black', unit: 'piece', unitPrice: 19.9, category: 'Filament' },
  { id: 'cat-inserts', name: 'Brass heat-set inserts M3, pack of 20', unit: 'pack', unitPrice: 4.5, category: 'Small parts' },
  { id: 'cat-screws', name: 'Screw assortment M3', unit: 'pack', unitPrice: 3, category: 'Small parts' },
  { id: 'cat-glue', name: 'Bed adhesive stick', unit: 'piece', unitPrice: 5.5, category: 'Small parts' },
  { id: 'cat-nozzle', name: 'Nozzle 0.4 mm, hardened', unit: 'piece', unitPrice: 12, category: 'Spare parts' },
  { id: 'cat-offcut', name: 'Plywood offcut, A4 size', unit: 'piece', unitPrice: 1.5, category: 'Sheet material' },
];
