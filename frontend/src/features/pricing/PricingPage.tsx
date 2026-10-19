import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  Button, IconButton, InlineNotification, Link as CarbonLink, Select, SelectItem, Stack, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableHeader, TableRow, TabList, TabPanel, TabPanels,
  Tabs, Tag, TextArea, TextInput, Toggle,
} from '@carbon/react';
import { Add, ArrowDown, ArrowUp, Checkmark, Close, Edit } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { listRoles } from '../../api/generated/roles/roles';
import { createPricingGroup, createPricingRule, setRolePricingGroups, updatePricingGroup, updatePricingRule } from '../../api/generated/pricing/pricing';
import type { PricingGroup } from '../../api/generated/models';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { materialTypesQuery } from '../machinelogbook/inventoryQueries';
import { machineLogbookKeys, machineTypesQuery, pricingQuery } from '../machinelogbook/queries';
import { CatalogFormModal as Modal } from '../machinelogbook/CatalogFormModal';
import { listOrganizations } from '../../api/generated/organizations/organizations';
import { parseDecimalInput } from '../orders/money';
import { rolePricingQuery } from '../orders/queries';
import { pricingGaps, rateSelectors, ruleOf, type RateSelector } from './selectors';
import '../orders/sales.scss';
import '../machinelogbook/shared/shared.scss';

const TABS = ['rates', 'roles', 'organizations'] as const;
const rateText = (rate: string) => rate.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1').replace('.', ',');

function useRefresh() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
}

function RateCell({ group, selector, canEdit }: { group: PricingGroup; selector: RateSelector; canEdit: boolean }) {
  const refresh = useRefresh();
  const rule = ruleOf(group, selector);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const parsed = parseDecimalInput(text);
  const mutation = useMutation({
    mutationFn: () => {
      const target = { kind: selector.kind, machineTypeId: selector.machineTypeId ?? null, materialTypeId: selector.materialTypeId ?? null, measure: selector.measure ?? null, rate: parsed! };
      return rule ? updatePricingRule(rule.id, { ...target, active: true, expectedVersion: rule.version }) : createPricingRule(group.id, target);
    },
    onSuccess: async () => { setEditing(false); await refresh(); },
  });
  const open = () => { mutation.reset(); setText(rule ? rateText(rule.rate) : ''); setEditing(true); };
  if (editing) {
    return (
      <div className="sales-rate-edit">
        <TextInput id={`rate-${group.id}-${selector.key}`} labelText={`Rate for ${selector.label} in ${group.name}`} hideLabel size="sm" inputMode="decimal" value={text} autoFocus invalid={(text !== '' && parsed === null) || mutation.isError} invalidText={mutation.error?.message ?? 'e.g. 0,08'}
          onChange={(event) => setText(event.target.value.replace(',', '.'))} onKeyDown={(event) => { if (event.key === 'Enter' && parsed !== null) mutation.mutate(); if (event.key === 'Escape') setEditing(false); }} />
        <IconButton label="Save rate" kind="ghost" size="sm" disabled={parsed === null || mutation.isPending} onClick={() => mutation.mutate()}><Checkmark /></IconButton>
        <IconButton label="Discard" kind="ghost" size="sm" onClick={() => setEditing(false)}><Close /></IconButton>
      </div>
    );
  }
  return (
    <div className="sales-rate">
      {rule ? <span className="sales-num">{rateText(rule.rate)} <span className="mj-secondary">{selector.unit}</span></span> : <Tag type="red" size="sm">Missing</Tag>}
      {canEdit && (rule
        ? <IconButton label={`Edit ${selector.label} for ${group.name}`} kind="ghost" size="sm" onClick={open}><Edit /></IconButton>
        : <Button kind="ghost" size="sm" renderIcon={Add} onClick={open}>Set rate</Button>)}
    </div>
  );
}

type GroupFields = { name: string; description: string; isDefault: boolean; active: boolean };

function GroupModal({ group, onClose }: { group: PricingGroup | null; onClose: () => void }) {
  const refresh = useRefresh();
  const form = useForm<GroupFields>({ defaultValues: group ? { name: group.name, description: group.description ?? '', isDefault: group.isDefault, active: group.active } : { name: '', description: '', isDefault: false, active: true } });
  const mutation = useMutation({
    mutationFn: (values: GroupFields) => group
      ? updatePricingGroup(group.id, { expectedVersion: group.version, name: values.name.trim(), description: values.description || null, active: values.active, isDefault: values.isDefault })
      : createPricingGroup({ name: values.name.trim(), description: values.description || null, isDefault: values.isDefault }),
    onSuccess: async () => { await refresh(); onClose(); },
  });
  return (
    <Modal open preventCloseOnClickOutside modalHeading={group ? 'Edit pricing group' : 'New pricing group'} primaryButtonText={mutation.isPending ? 'Saving…' : group ? 'Save group' : 'Add group'} secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending} onRequestClose={() => { if (!mutation.isPending) onClose(); }} onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}>
      <Stack gap={5}>
        <TextInput id="pricing-group-name" labelText="Name" invalid={!!form.formState.errors.name} invalidText="Enter a name" {...form.register('name', { validate: (value) => value.trim() !== '' })} />
        <TextArea id="pricing-group-description" labelText="Description" {...form.register('description')} />
        <Controller control={form.control} name="isDefault" render={({ field }) => <Toggle id="pricing-group-default" labelText="Default group" labelA="No" labelB="Yes" toggled={field.value} onToggle={field.onChange} />} />
        {group && <Controller control={form.control} name="active" render={({ field }) => <Toggle id="pricing-group-active" labelText="Active" labelA="Inactive" labelB="Active" toggled={field.value} onToggle={field.onChange} />} />}
        {group && <p className="mj-secondary">Inactive groups are unavailable for new pricing. Existing price snapshots remain unchanged.</p>}
        {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Pricing group not saved" subtitle={mutation.error.message} />}
      </Stack>
    </Modal>
  );
}

function RatesTab({ groups, selectors, canEdit, partial }: { groups: PricingGroup[]; selectors: RateSelector[]; canEdit: boolean; partial: boolean }) {
  const [editing, setEditing] = useState<PricingGroup | 'new' | null>(null);
  const active = groups.filter((group) => group.active);
  const gaps = pricingGaps(groups, selectors);
  return (
    <Stack gap={7}>
      {gaps.length > 0 && (
        <InlineNotification kind="warning" lowContrast hideCloseButton title={`${gaps.length} ${gaps.length === 1 ? 'rate is' : 'rates are'} missing`}
          subtitle={`Jobs that need ${gaps.length === 1 ? 'it' : 'them'} cannot be priced: ${gaps.slice(0, 3).map((gap) => `${gap.selector.label.toLowerCase()} for ${gap.group.name}`).join(', ')}${gaps.length > 3 ? ` and ${gaps.length - 3} more` : ''}.`} />
      )}
      {partial && <InlineNotification kind="info" lowContrast hideCloseButton title="Some rates are not shown" subtitle="Machine types need the permission to read machines, material types the permission to read inventory." />}
      <TableContainer title="Rates" description={canEdit ? 'Each cell is the price of one hour of machine time, a measure block or one unit of material. An explicit 0 means free.' : 'Each cell is the price of one hour of machine time, a measure block or one unit of material.'}>
        <Table aria-label="Rates by pricing group" className="sales-rates">
          <TableHead>
            <TableRow>
              <TableHeader>Rate</TableHeader>
              {active.map((group) => <TableHeader key={group.id}>{group.name}{group.isDefault && <> <Tag type="blue" size="sm">Default</Tag></>}</TableHeader>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {selectors.length === 0 && <TableRow><TableCell colSpan={active.length + 1}>No machine or material types to price yet.</TableCell></TableRow>}
            {selectors.map((selector) => (
              <TableRow key={selector.key}>
                <TableCell><div className="mj-cell-stack"><strong>{selector.label}</strong><span className="mj-secondary">{selector.description}</span></div></TableCell>
                {active.map((group) => <TableCell key={group.id}><RateCell group={group} selector={selector} canEdit={canEdit} /></TableCell>)}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      <TableContainer title="Pricing groups" description="A job is priced with the group set on the job, else the group of its organization, else the group mapped to the customer's highest-priority role, else the default group.">
        {canEdit && <div className="sales-section-actions"><Button kind="primary" size="md" renderIcon={Add} onClick={() => setEditing('new')}>New group</Button></div>}
        <Table aria-label="Pricing groups">
          <TableHead><TableRow><TableHeader>Group</TableHeader><TableHeader className="mj-hide-narrow">Description</TableHeader><TableHeader>Status</TableHeader><TableHeader className="mj-hide-narrow">Rates</TableHeader><TableHeader><span className="cds--visually-hidden">Actions</span></TableHeader></TableRow></TableHead>
          <TableBody>
            {groups.map((group) => {
              const missing = group.active ? gaps.filter((gap) => gap.group.id === group.id).length : 0;
              return (
                <TableRow key={group.id}>
                  <TableCell><span className="mj-inline"><strong>{group.name}</strong>{group.isDefault && <Tag type="blue" size="sm">Default</Tag>}</span></TableCell>
                  <TableCell className="mj-hide-narrow">{group.description || <span className="mj-secondary">—</span>}</TableCell>
                  <TableCell><Tag type={group.active ? 'green' : 'warm-gray'} size="sm">{group.active ? 'Active' : 'Inactive'}</Tag></TableCell>
                  <TableCell className="mj-hide-narrow">{missing > 0 ? <Tag type="red" size="sm">{missing} missing</Tag> : group.active ? <Tag type="green" size="sm">Complete</Tag> : '—'}</TableCell>
                  <TableCell className="sales-row-actions">{canEdit && <IconButton label={`Edit ${group.name}`} kind="ghost" size="sm" onClick={() => setEditing(group)}><Edit /></IconButton>}</TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      {editing && <GroupModal group={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Stack>
  );
}

type Mapping = { roleId: string; roleName: string; groupId: string };

function RoleMappingTab({ groups, canEdit }: { groups: PricingGroup[]; canEdit: boolean }) {
  const user = useCurrentUser();
  const refresh = useRefresh();
  const mapped = useQuery(rolePricingQuery());
  const canListRoles = hasPermission(user, PermissionId.rolesread);
  const roles = useQuery({ queryKey: ['roles', 'all-for-pricing'], queryFn: () => listRoles({ limit: 100 }), enabled: canListRoles });
  const [draft, setDraft] = useState<Mapping[] | null>(null);
  const defaultGroup = groups.find((group) => group.isDefault);
  const active = groups.filter((group) => group.active);

  const base: Mapping[] = [
    ...(mapped.data?.items ?? []).map((item) => ({ roleId: item.roleId, roleName: item.roleName, groupId: item.pricingGroupId })),
    ...(roles.data?.items ?? []).filter((role) => !(mapped.data?.items ?? []).some((item) => item.roleId === role.id)).map((role) => ({ roleId: role.id, roleName: role.name, groupId: '' })),
  ];
  const rows = draft ?? base;
  const dirty = draft !== null;
  const save = useMutation({
    mutationFn: () => {
      const chosen = rows.filter((row) => row.groupId);
      return setRolePricingGroups({ items: chosen.map((row, index) => ({ roleId: row.roleId, pricingGroupId: row.groupId, priority: chosen.length - index })) });
    },
    onSuccess: async () => { setDraft(null); await refresh(); },
  });
  const changeDefault = useMutation({
    mutationFn: (id: string) => { const group = groups.find((item) => item.id === id)!; return updatePricingGroup(id, { expectedVersion: group.version, name: group.name, description: group.description ?? null, active: true, isDefault: true }); },
    onSuccess: refresh,
  });
  const edit = (next: Mapping[]) => setDraft(next);
  const move = (index: number, by: number) => { const next = [...rows]; [next[index], next[index + by]] = [next[index + by], next[index]]; edit(next); };

  if (mapped.isPending) return <FullPageLoading label="Loading role mapping" />;
  if (mapped.isError) return <ErrorState message="The role mapping could not be loaded." onRetry={() => mapped.refetch()} />;
  return (
    <Stack gap={5}>
      <InlineNotification kind="info" lowContrast hideCloseButton title="Accounts are priced by their roles" subtitle="Map each role to a pricing group. If an account has several roles, the mapped role highest in this list decides. A group on the job or on the organization wins over this." />
      <TableContainer title="Role mapping" description="Highest priority first. Jobs that already have a price keep it.">
        <Table aria-label="Roles and their pricing groups">
          <TableHead><TableRow><TableHeader>Priority</TableHeader><TableHeader>Role</TableHeader><TableHeader>Pricing group</TableHeader>{canEdit && <TableHeader><span className="cds--visually-hidden">Order</span></TableHeader>}</TableRow></TableHead>
          <TableBody>
            {rows.map((row, index) => (
              <TableRow key={row.roleId}>
                <TableCell>{row.groupId ? index + 1 : '—'}</TableCell>
                <TableCell><strong>{row.roleName}</strong></TableCell>
                <TableCell>
                  {canEdit ? (
                    <Select id={`role-${row.roleId}`} labelText={`Pricing group of the role ${row.roleName}`} hideLabel size="sm" value={row.groupId} onChange={(event) => edit(rows.map((item) => item.roleId === row.roleId ? { ...item, groupId: event.target.value } : item))}>
                      <SelectItem value="" text={`Not mapped${defaultGroup ? ` (default group ${defaultGroup.name})` : ''}`} />
                      {groups.filter((group) => group.active || group.id === row.groupId).map((group) => <SelectItem key={group.id} value={group.id} text={`${group.name}${group.active ? '' : ' (inactive)'}`} />)}
                    </Select>
                  ) : (groups.find((group) => group.id === row.groupId)?.name ?? `Not mapped${defaultGroup ? ` (default group ${defaultGroup.name})` : ''}`)}
                </TableCell>
                {canEdit && (
                  <TableCell className="sales-row-actions">
                    <IconButton label={`Move ${row.roleName} up`} kind="ghost" size="sm" disabled={index === 0} onClick={() => move(index, -1)}><ArrowUp /></IconButton>
                    <IconButton label={`Move ${row.roleName} down`} kind="ghost" size="sm" disabled={index === rows.length - 1} onClick={() => move(index, 1)}><ArrowDown /></IconButton>
                  </TableCell>
                )}
              </TableRow>
            ))}
            <TableRow>
              <TableCell>—</TableCell>
              <TableCell><strong>No mapped role</strong><br /><span className="mj-secondary">The default group</span></TableCell>
              <TableCell>
                {canEdit ? (
                  <Select id="role-default" labelText="Default pricing group" hideLabel size="sm" value={defaultGroup?.id ?? ''} disabled={changeDefault.isPending} onChange={(event) => changeDefault.mutate(event.target.value)}>
                    {active.map((group) => <SelectItem key={group.id} value={group.id} text={group.name} />)}
                  </Select>
                ) : (defaultGroup?.name ?? '—')}
              </TableCell>
              {canEdit && <TableCell />}
            </TableRow>
          </TableBody>
        </Table>
        {!canListRoles && canEdit && <p className="mj-secondary sales-top-gap">Only mapped roles are listed. Listing every role needs the permission to read roles.</p>}
      </TableContainer>
      {(save.isError || changeDefault.isError) && <InlineNotification kind="error" lowContrast hideCloseButton title="Not saved" subtitle={(save.error ?? changeDefault.error)?.message} />}
      {canEdit && (
        <div className="mj-inline">
          <Button kind="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? 'Saving…' : 'Save role mapping'}</Button>
          <Button kind="ghost" disabled={!dirty || save.isPending} onClick={() => setDraft(null)}>Discard changes</Button>
        </div>
      )}
    </Stack>
  );
}

function OrganizationsTab({ defaultName }: { defaultName: string }) {
  const query = useQuery({ queryKey: ['organizations', 'pricing-overview'], queryFn: () => listOrganizations({ page: 1, pageSize: 100 }) });
  return (
    <TableContainer title="Organizations" description="An organization's pricing group wins over the roles of its members. Change it on the organization's page.">
      <Table aria-label="Organizations and their pricing groups">
        <TableHead><TableRow><TableHeader>Organization</TableHeader><TableHeader className="mj-hide-narrow">Kind</TableHeader><TableHeader>Pricing group</TableHeader><TableHeader>Status</TableHeader></TableRow></TableHead>
        <TableBody>
          {query.isPending && <TableRow><TableCell colSpan={4}>Loading…</TableCell></TableRow>}
          {query.isError && <TableRow><TableCell colSpan={4}>The organizations could not be loaded.</TableCell></TableRow>}
          {query.data?.items.map((organization) => (
            <TableRow key={organization.id}>
              <TableCell><CarbonLink as={Link} to={`/organizations/${organization.id}`}>{organization.name}</CarbonLink></TableCell>
              <TableCell className="mj-hide-narrow">{organization.kind}</TableCell>
              <TableCell>{organization.pricingGroup?.name ?? <span className="mj-secondary">Default ({defaultName})</span>}</TableCell>
              <TableCell><Tag type={organization.active ? 'green' : 'warm-gray'} size="sm">{organization.active ? 'Active' : 'Inactive'}</Tag></TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

export function PricingPage() {
  const user = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const canMachines = hasPermission(user, PermissionId.machinesread);
  const canInventory = hasPermission(user, PermissionId.inventoryread);
  const canEdit = hasPermission(user, PermissionId.pricingmanage);
  const canOrganizations = hasPermission(user, PermissionId.organizationsread);
  const pricing = useQuery(pricingQuery());
  const machineTypes = useQuery({ ...machineTypesQuery(), enabled: canMachines });
  const materialTypes = useQuery({ ...materialTypesQuery(), enabled: canInventory });
  const tabs = TABS.filter((id) => id !== 'organizations' || canOrganizations);
  const tab = Math.max(0, tabs.indexOf((params.get('tab') ?? 'rates') as (typeof TABS)[number]));
  const groups = pricing.data?.items ?? [];
  const selectors = rateSelectors(machineTypes.data?.items ?? [], materialTypes.data ?? []);
  const gaps = pricingGaps(groups, selectors).length;
  const defaultName = groups.find((group) => group.isDefault)?.name ?? 'none';
  return (
    <PageShell className="sales-page" title="Pricing" description="Rates per pricing group, which group prices which role, and the organizations' groups." width="wide" breadcrumbs={[{ label: 'Sales & payments', to: '/sales' }, { label: 'Pricing' }]}>
      {pricing.isPending ? <FullPageLoading label="Loading pricing" /> : pricing.isError ? <ErrorState message="The pricing could not be loaded." onRetry={() => pricing.refetch()} /> : (
        <Tabs selectedIndex={tab} onChange={({ selectedIndex }) => setParams(selectedIndex === 0 ? {} : { tab: tabs[selectedIndex] }, { replace: true })}>
          <TabList aria-label="Pricing sections" contained>
            <Tab>Groups &amp; rates{gaps > 0 && <Tag type="red" size="sm" className="sales-tab-count">{gaps}</Tag>}</Tab><Tab>Role mapping</Tab>{canOrganizations && <Tab>Organizations</Tab>}
          </TabList>
          <TabPanels>
            <TabPanel className="sales-tab-panel"><RatesTab groups={groups} selectors={selectors} canEdit={canEdit} partial={!canMachines || !canInventory} /></TabPanel>
            <TabPanel className="sales-tab-panel"><RoleMappingTab groups={groups} canEdit={canEdit} /></TabPanel>
            {canOrganizations && <TabPanel className="sales-tab-panel"><OrganizationsTab defaultName={defaultName} /></TabPanel>}
          </TabPanels>
        </Tabs>
      )}
    </PageShell>
  );
}
