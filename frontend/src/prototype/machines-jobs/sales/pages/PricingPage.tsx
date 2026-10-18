import { useMemo, useState } from 'react';
import {
  Button, ComboBox, IconButton, InlineNotification, NumberInput, Select, SelectItem, Stack, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TabList, TabPanel,
  TabPanels, Tabs, Tag, TextInput, Tile,
} from '@carbon/react';
import { Add, Checkmark, Close, Edit, TrashCan } from '@carbon/icons-react';
import { PageShell } from '../../../../app/PageShell';
import { QueryBoundary } from '../../components/QueryBoundary';
import { lookups, useStore } from '../../store';
import { matchesName } from '../../dialogs/jobFormHelpers';
import { RequirePermission } from '../components/RequirePermission';
import { OrganizationModal } from '../dialogs/OrganizationModal';
import { PricingGroupModal } from '../dialogs/PricingGroupModal';
import { formatAmount, formatEur } from '../format';
import { organizationKindLabel } from '../labels';
import { accountRoles, defaultGroupOf, pricingGaps, quoteJob, rateOf, rateSelectors, resolveGroup, unitLabel, type PricingGroup, type RateSelector } from '../pricing';
import { ProposedTag } from '../status';
import type { OrganizationRecord } from '../types';
import { useSalesData } from '../useSalesData';
import { useSalesMutation } from '../useSalesMutation';
import { useUrlParams } from '../useUrlParams';
import '../sales.scss';

const TABS = ['rates', 'roles', 'organizations', 'preview'] as const;
const selectorUnit = (selector: RateSelector) => `€/${unitLabel(selector.unit)}`;
const parseRate = (text: string) => { const value = text.trim().replace(',', '.'); return /^\d+(\.\d{1,4})?$/.test(value) ? Number(value) : null; };

function RateCell({ group, selector, canEdit }: { group: PricingGroup; selector: RateSelector; canEdit: boolean }) {
  const store = useStore();
  const rule = rateOf(store.pricing, group.id, selector);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const parsed = parseRate(text);
  const { mutate, pending, error } = useSalesMutation(() => store.setRate({ groupId: group.id, kind: selector.kind, machineTypeId: selector.machineTypeId, category: selector.category, unit: selector.unit, rate: parsed! }), 150);
  const open = () => { setText(rule ? String(rule.rate).replace('.', ',') : ''); setEditing(true); };
  const save = async () => { const result = await mutate(); if (result.ok) { setEditing(false); store.notify({ kind: 'success', title: 'Rate saved', subtitle: `${selector.label} for ${group.name}: ${formatAmount(parsed!)} ${selectorUnit(selector)}. Jobs priced from now on use it.` }); } };
  if (editing) {
    return (
      <div className="sales-rate-edit">
        <TextInput id={`rate-${group.id}-${selector.key}`} labelText={`Rate for ${selector.label} in ${group.name}`} hideLabel size="sm" inputMode="decimal" value={text} autoFocus invalid={text !== '' && parsed === null || !!error} invalidText={error ?? 'e.g. 0,08'}
          onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && parsed !== null) void save(); if (event.key === 'Escape') setEditing(false); }} />
        <IconButton label="Save rate" kind="ghost" size="sm" disabled={parsed === null || pending} onClick={() => { void save(); }}><Checkmark /></IconButton>
        <IconButton label="Discard" kind="ghost" size="sm" onClick={() => setEditing(false)}><Close /></IconButton>
      </div>
    );
  }
  return (
    <div className="sales-rate">
      {rule ? <span className="sales-num">{formatAmount(rule.rate)} <span className="mj-secondary">{selectorUnit(selector)}</span></span> : <Tag type="red" size="sm">Missing</Tag>}
      {canEdit && (rule
        ? <IconButton label={`Edit ${selector.label} for ${group.name}`} kind="ghost" size="sm" onClick={open}><Edit /></IconButton>
        : <Button kind="ghost" size="sm" renderIcon={Add} onClick={open}>Set rate</Button>)}
    </div>
  );
}

function RatesTab({ selectors, canEdit }: { selectors: RateSelector[]; canEdit: boolean }) {
  const store = useStore();
  const groups = store.pricing.groups.filter((group) => group.active);
  const gaps = pricingGaps(store.pricing, selectors);
  return (
    <Stack gap={5}>
      {gaps.length > 0 && (
        <InlineNotification kind="warning" lowContrast hideCloseButton title={`${gaps.length} ${gaps.length === 1 ? 'rate is' : 'rates are'} missing`}
          subtitle={`Jobs that need ${gaps.length === 1 ? 'it' : 'them'} cannot be priced: ${gaps.slice(0, 3).map((gap) => `${gap.selector.label.toLowerCase()} for ${gap.group.name}`).join(', ')}${gaps.length > 3 ? ` and ${gaps.length - 3} more` : ''}.`} />
      )}
      <TableContainer className="mj-table-container" title="Rates" description={canEdit ? 'Each cell is the price of one hour of machine time or one unit of material. Select the pencil to change it.' : 'Each cell is the price of one hour of machine time or one unit of material.'}>
        <Table aria-label="Rates by pricing group" className="sales-rates">
          <TableHead>
            <TableRow>
              <TableHeader>Rate</TableHeader>
              {groups.map((group) => <TableHeader key={group.id}>{group.name}{group.isDefault && <> <Tag type="blue" size="sm">Default</Tag></>}</TableHeader>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {selectors.map((selector) => (
              <TableRow key={selector.key}>
                <TableCell><div className="mj-cell-stack"><strong>{selector.label}</strong><span className="mj-secondary">{selector.kind === 'machine_runtime' ? 'Per hour of machine time' : `Per ${unitLabel(selector.unit)}`}</span></div></TableCell>
                {groups.map((group) => <TableCell key={group.id}><RateCell group={group} selector={selector} canEdit={canEdit} /></TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {store.pricing.groups.some((group) => !group.active) && <p className="mj-secondary">Inactive groups are hidden here. Activate a group in Groups to change its rates.</p>}
    </Stack>
  );
}

function GroupsTab({ selectors, canEdit }: { selectors: RateSelector[]; canEdit: boolean }) {
  const store = useStore();
  const [editing, setEditing] = useState<PricingGroup | 'new' | null>(null);
  const gaps = pricingGaps(store.pricing, selectors);
  return (
    <TableContainer title="Pricing groups" description="A job is priced with the group set on the job, else the group of its organization, else the group mapped to the highest-priority role of the account, else the default group.">
      <div className="sales-section-actions">{canEdit && <Button kind="primary" size="md" renderIcon={Add} onClick={() => setEditing('new')}>New group</Button>}</div>
      <Table aria-label="Pricing groups">
        <TableHead>
          <TableRow><TableHeader>Group</TableHeader><TableHeader className="mj-hide-narrow">Description</TableHeader><TableHeader>Status</TableHeader><TableHeader>Used by</TableHeader><TableHeader className="mj-hide-narrow">Rates</TableHeader><TableHeader><span className="cds--visually-hidden">Actions</span></TableHeader></TableRow>
        </TableHead>
        <TableBody>
          {store.pricing.groups.map((group) => {
            const missing = group.active ? gaps.filter((gap) => gap.group.id === group.id).length : 0;
            const roles = accountRoles.filter((role) => store.pricing.roleGroups[role.id] === group.name).length;
            const organizations = store.organizations.filter((organization) => organization.pricingGroup === group.name).length;
            return (
              <TableRow key={group.id}>
                <TableCell><span className="mj-inline"><strong>{group.name}</strong>{group.isDefault && <Tag type="blue" size="sm">Default</Tag>}</span></TableCell>
                <TableCell className="mj-hide-narrow">{group.description || <span className="mj-secondary">—</span>}</TableCell>
                <TableCell><Tag type={group.active ? 'green' : 'warm-gray'} size="sm">{group.active ? 'Active' : 'Inactive'}</Tag></TableCell>
                <TableCell>{[roles ? `${roles} ${roles === 1 ? 'role' : 'roles'}` : '', organizations ? `${organizations} ${organizations === 1 ? 'organization' : 'organizations'}` : '', group.isDefault ? 'everything else' : ''].filter(Boolean).join(' · ') || <span className="mj-secondary">Nothing</span>}</TableCell>
                <TableCell className="mj-hide-narrow">{missing > 0 ? <Tag type="red" size="sm">{missing} missing</Tag> : group.active ? <Tag type="green" size="sm">Complete</Tag> : '—'}</TableCell>
                <TableCell className="sales-row-actions">{canEdit && <IconButton label={`Edit ${group.name}`} kind="ghost" size="sm" onClick={() => setEditing(group)}><Edit /></IconButton>}</TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {editing && <PricingGroupModal group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </TableContainer>
  );
}

function RoleMappingTab({ canEdit }: { canEdit: boolean }) {
  const store = useStore();
  const defaultGroup = defaultGroupOf(store.pricing);
  const active = store.pricing.groups.filter((group) => group.active);
  const accounts = (roleId: string) => lookups.people.filter((party) => party.kind === 'person' && party.roles.includes(roleId)).length;
  const change = (roleId: string, label: string, value: string) => {
    try { store.setRoleGroup(roleId, value || null); store.notify({ kind: 'success', title: 'Role mapping saved', subtitle: `Accounts with the role ${label} are priced with ${value || defaultGroup.name} from now on.` }); }
    catch (error) { store.notify({ kind: 'error', title: 'Not saved', subtitle: error instanceof Error ? error.message : undefined }); }
  };
  const changeDefault = (id: string) => {
    const group = store.pricing.groups.find((item) => item.id === id);
    if (!group || group.isDefault) return;
    try { store.savePricingGroup({ id: group.id, name: group.name, description: group.description, active: true, isDefault: true }); store.notify({ kind: 'success', title: 'Default group changed', subtitle: `${group.name} prices everything that no role, organization or job decides.` }); }
    catch (error) { store.notify({ kind: 'error', title: 'Not saved', subtitle: error instanceof Error ? error.message : undefined }); }
  };
  return (
    <Stack gap={5}>
      <InlineNotification kind="info" lowContrast hideCloseButton title="Accounts are priced by their roles" subtitle="Everybody who is a customer is already an account. Map each account role to a pricing group here. If an account has several roles, the first one in this list that is mapped decides." />
      <TableContainer title={<span className="mj-inline">Role mapping <ProposedTag hint="Needs a role to pricing group mapping on the backend" /></span>} description="Highest priority first. Jobs that already have a price keep it.">
        <Table aria-label="Account roles and their pricing groups">
          <TableHead><TableRow><TableHeader>Priority</TableHeader><TableHeader>Account role</TableHeader><TableHeader className="sales-num">Accounts</TableHeader><TableHeader>Pricing group</TableHeader></TableRow></TableHead>
          <TableBody>
            {accountRoles.map((role, index) => {
              const mapped = store.pricing.roleGroups[role.id] ?? '';
              return (
                <TableRow key={role.id}>
                  <TableCell>{index + 1}</TableCell>
                  <TableCell><strong>{role.label}</strong></TableCell>
                  <TableCell className="sales-num">{accounts(role.id)}</TableCell>
                  <TableCell>
                    {canEdit ? (
                      <Select id={`role-${role.id}`} labelText={`Pricing group of the role ${role.label}`} hideLabel size="sm" value={mapped} onChange={(event) => change(role.id, role.label, event.target.value)}>
                        <SelectItem value="" text={`Not mapped (default group ${defaultGroup.name})`} />
                        {store.pricing.groups.filter((group) => group.active || group.name === mapped).map((group) => <SelectItem key={group.id} value={group.name} text={`${group.name}${group.active ? '' : ' (inactive)'}`} />)}
                      </Select>
                    ) : (mapped || `Not mapped (default group ${defaultGroup.name})`)}
                  </TableCell>
                </TableRow>
              );
            })}
            <TableRow>
              <TableCell>—</TableCell>
              <TableCell><strong>No mapped role</strong><br /><span className="mj-secondary">The default group</span></TableCell>
              <TableCell className="sales-num">{lookups.people.filter((party) => party.kind === 'person' && !party.roles.some((role) => store.pricing.roleGroups[role])).length}</TableCell>
              <TableCell>
                {canEdit ? (
                  <Select id="role-default" labelText="Default pricing group" hideLabel size="sm" value={defaultGroup.id} onChange={(event) => changeDefault(event.target.value)}>
                    {active.map((group) => <SelectItem key={group.id} value={group.id} text={group.name} />)}
                  </Select>
                ) : defaultGroup.name}
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}

function OrganizationsTab({ canEdit }: { canEdit: boolean }) {
  const store = useStore();
  const [editing, setEditing] = useState<OrganizationRecord | 'new' | null>(null);
  const defaultName = defaultGroupOf(store.pricing).name;
  return (
    <TableContainer title={<span className="mj-inline">Organizations <ProposedTag hint="Needs an organization pricing group on the backend" /></span>} description="Institutes, companies and associations are the only customers that are not accounts. Their group wins over the account roles.">
      <div className="sales-section-actions">{canEdit && <Button kind="primary" size="md" renderIcon={Add} onClick={() => setEditing('new')}>New organization</Button>}</div>
      <Table aria-label="Organizations">
        <TableHead>
          <TableRow><TableHeader>Organization</TableHeader><TableHeader className="mj-hide-narrow">Kind</TableHeader><TableHeader>Pricing group</TableHeader><TableHeader className="mj-hide-narrow">Purchase order</TableHeader><TableHeader>Status</TableHeader><TableHeader><span className="cds--visually-hidden">Actions</span></TableHeader></TableRow>
        </TableHead>
        <TableBody>
          {[...store.organizations].sort((a, b) => a.name.localeCompare(b.name)).map((organization) => (
            <TableRow key={organization.id}>
              <TableCell><strong>{organization.name}</strong></TableCell>
              <TableCell className="mj-hide-narrow">{organizationKindLabel[organization.kind]}</TableCell>
              <TableCell>{organization.pricingGroup ?? <span className="mj-secondary">Default ({defaultName})</span>}</TableCell>
              <TableCell className="mj-hide-narrow"><Tag type={organization.requiresPurchaseOrder ? 'blue' : 'gray'} size="sm">{organization.requiresPurchaseOrder ? 'Required' : 'Not required'}</Tag></TableCell>
              <TableCell><Tag type={organization.active ? 'green' : 'warm-gray'} size="sm">{organization.active ? 'Active' : 'Inactive'}</Tag></TableCell>
              <TableCell className="sales-row-actions">{canEdit && <IconButton label={`Edit ${organization.name}`} kind="ghost" size="sm" onClick={() => setEditing(organization)}><Edit /></IconButton>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {editing && <OrganizationModal organization={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </TableContainer>
  );
}

type PreviewLine = { key: number; selector: string; quantity: number };

function PreviewTab({ selectors }: { selectors: RateSelector[] }) {
  const store = useStore();
  const machineTypes = store.machineTypes.filter((type) => type.active);
  const materialSelectors = selectors.filter((selector) => selector.kind === 'material');
  const [machineTypeId, setMachineTypeId] = useState(machineTypes[0]?.id ?? '');
  const [hours, setHours] = useState(2);
  const [minutes, setMinutes] = useState(0);
  const [lines, setLines] = useState<PreviewLine[]>([{ key: 1, selector: materialSelectors[0]?.key ?? '', quantity: 80 }]);
  const [groupName, setGroupName] = useState(() => store.pricing.groups.find((group) => group.isDefault)?.name ?? '');
  const [nextKey, setNextKey] = useState(2);
  const [customer, setCustomer] = useState<(typeof lookups.people)[number] | null>(null);
  const resolved = customer ? resolveGroup(store.pricing, store.organizations, customer) : null;
  const usages = lines.flatMap((line) => { const selector = materialSelectors.find((item) => item.key === line.selector); return selector && line.quantity > 0 ? [{ materialName: selector.category ?? '', category: selector.category, unit: selector.unit, quantity: line.quantity, ownership: 'makerspace' as const }] : []; });
  const input = { durationSeconds: Math.round((hours * 60 + minutes) * 60), machineTypeId, usages };
  const quote = quoteJob({ ...input, group: groupName }, store.pricing);
  const compare = store.pricing.groups.filter((group) => group.active).map((group) => ({ group, quote: quoteJob({ ...input, group: group.name }, store.pricing) }));
  const count = (value: unknown) => { const number = typeof value === 'number' ? value : Number(value); return Number.isFinite(number) && number >= 0 ? number : 0; };

  return (
    <div className="sales-two-cols">
      <Tile>
        <h2 className="mj-section-title">What would this job cost?</h2>
        <Stack gap={5}>
          <Select id="preview-machine" labelText="Machine type" value={machineTypeId} onChange={(event) => setMachineTypeId(event.target.value)}>
            {machineTypes.map((type) => <SelectItem key={type.id} value={type.id} text={type.name} />)}
          </Select>
          <div className="sales-form-grid">
            <NumberInput id="preview-hours" label="Hours" min={0} step={1} allowEmpty value={hours} onChange={(_event, state) => setHours(count(state.value))} />
            <NumberInput id="preview-minutes" label="Minutes" min={0} max={59} step={5} allowEmpty value={minutes} onChange={(_event, state) => setMinutes(count(state.value))} />
          </div>
          {lines.map((line, index) => {
            const selector = materialSelectors.find((item) => item.key === line.selector);
            return (
              <div key={line.key} className="sales-preview-line">
                <Select id={`preview-material-${line.key}`} labelText={index === 0 ? 'Material' : `Material ${index + 1}`} value={line.selector} onChange={(event) => setLines((current) => current.map((item) => item.key === line.key ? { ...item, selector: event.target.value } : item))}>
                  {materialSelectors.map((item) => <SelectItem key={item.key} value={item.key} text={`${item.category} (${unitLabel(item.unit)})`} />)}
                </Select>
                <NumberInput id={`preview-quantity-${line.key}`} label={`Quantity (${selector ? unitLabel(selector.unit) : ''})`} min={0} step={selector?.unit === 'm2' ? 0.1 : 10} allowEmpty value={line.quantity} onChange={(_event, state) => setLines((current) => current.map((item) => item.key === line.key ? { ...item, quantity: count(state.value) } : item))} />
                <IconButton label="Remove this material" kind="ghost" size="md" disabled={lines.length === 0} onClick={() => setLines((current) => current.filter((item) => item.key !== line.key))}><TrashCan /></IconButton>
              </div>
            );
          })}
          <div><Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => { setLines((current) => [...current, { key: nextKey, selector: materialSelectors[0]?.key ?? '', quantity: 0 }]); setNextKey((value) => value + 1); }}>Add material</Button></div>
          <ComboBox autoAlign id="preview-customer" titleText="Customer (optional)" placeholder="Search people or organizations" items={lookups.people} itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName} selectedItem={customer}
            helperText={resolved ? `${resolved.group.name} (${resolved.reason})` : 'Choose a customer to see which group prices them and why.'}
            onChange={({ selectedItem }) => { setCustomer(selectedItem ?? null); if (selectedItem) setGroupName(resolveGroup(store.pricing, store.organizations, selectedItem).group.name); }} />
          <Select id="preview-group" labelText="Pricing group" value={groupName} onChange={(event) => { setGroupName(event.target.value); setCustomer(null); }}>
            {store.pricing.groups.filter((group) => group.active).map((group) => <SelectItem key={group.id} value={group.name} text={`${group.name}${group.isDefault ? ' (default)' : ''}`} />)}
          </Select>
        </Stack>
      </Tile>
      <Stack gap={5}>
        <Tile>
          <h2 className="mj-section-title">Price for {groupName}{resolved ? ` (${resolved.reason})` : ''}</h2>
          <Stack gap={5}>
            <ul className="sales-quote">
              {quote.lines.map((line) => <li key={line.key}><span className="mj-cell-stack"><span>{line.label}</span><span className={line.missing ? 'sales-field-error' : 'mj-secondary'}>{line.detail}</span></span><span>{line.missing ? <Tag type="red" size="sm">Missing</Tag> : formatEur(line.amount)}</span></li>)}
            </ul>
            <div className="sales-total"><span>Total</span><strong>{quote.complete ? formatEur(quote.total) : '—'}</strong></div>
            {!quote.complete && <InlineNotification kind="warning" lowContrast hideCloseButton title="This job could not be priced" subtitle={`There is no rate for ${quote.missing.join(' and ')}. Set it in Rates.`} />}
          </Stack>
        </Tile>
        <TableContainer title="The same job in every group">
          <Table aria-label="Price by pricing group" size="sm">
            <TableHead><TableRow><TableHeader>Group</TableHeader><TableHeader className="sales-num">Price</TableHeader></TableRow></TableHead>
            <TableBody>
              {compare.map(({ group, quote: other }) => (
                <TableRow key={group.id}><TableCell>{group.name}</TableCell><TableCell className="sales-num">{other.complete ? formatEur(other.total) : <Tag type="red" size="sm">Rate missing</Tag>}</TableCell></TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Stack>
    </div>
  );
}

function Pricing() {
  const store = useStore();
  const { params, update } = useUrlParams();
  const tab = Math.max(0, TABS.indexOf((params.get('tab') ?? 'rates') as (typeof TABS)[number]));
  const selectors = useMemo(() => rateSelectors(store.machineTypes, store.materials), [store.machineTypes, store.materials]);
  const canEdit = store.can('pricing.manage');
  const gaps = pricingGaps(store.pricing, selectors).length;
  return (
    <Tabs selectedIndex={tab} onChange={({ selectedIndex }) => update({ tab: selectedIndex === 0 ? null : TABS[selectedIndex] })}>
      <TabList aria-label="Pricing sections" contained>
        <Tab>Groups &amp; rates{gaps > 0 && <Tag type="red" size="sm" className="sales-tab-count">{gaps}</Tag>}</Tab><Tab>Role mapping</Tab><Tab>Organizations</Tab><Tab>Price preview</Tab>
      </TabList>
      <TabPanels>
        <TabPanel className="sales-tab-panel"><Stack gap={7}><RatesTab selectors={selectors} canEdit={canEdit} /><GroupsTab selectors={selectors} canEdit={canEdit} /></Stack></TabPanel>
        <TabPanel className="sales-tab-panel"><RoleMappingTab canEdit={canEdit} /></TabPanel>
        <TabPanel className="sales-tab-panel"><OrganizationsTab canEdit={store.can('organizations.manage')} /></TabPanel>
        <TabPanel className="sales-tab-panel"><PreviewTab selectors={selectors} /></TabPanel>
      </TabPanels>
    </Tabs>
  );
}

export function PricingPage() {
  const { query } = useSalesData();
  return (
    <RequirePermission permission="pricing.read" title="Pricing" crumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Pricing' }]}>
      <PageShell title="Pricing" description="Pricing groups and rates, which group prices which account role, organizations, and what a job would cost." width="wide" breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Pricing' }]}>
        <QueryBoundary query={query} errorMessage="The pricing could not be loaded.">
          <Pricing />
        </QueryBoundary>
      </PageShell>
    </RequirePermission>
  );
}
