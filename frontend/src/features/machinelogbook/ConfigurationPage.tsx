import {
  Button,
  InlineNotification,
  Modal,
  Select,
  SelectItem,
  Stack,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  TextArea,
  TextInput,
  Tile,
  Toggle,
} from '@carbon/react';
import { Add, Edit } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import type {
  Organization,
  OrganizationKind,
  PricingGroup,
  PricingRule,
  PricingRuleKind,
} from '../../api/generated/models';
import { createOrganization, updateOrganization } from '../../api/generated/organizations/organizations';
import {
  createPricingGroup,
  createPricingRule,
  setBillingPartyPricingGroup,
  updatePricingGroup,
  updatePricingRule,
} from '../../api/generated/pricing/pricing';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { PermissionId, hasPermission } from '../auth/permissions';
import { useCurrentUser } from '../auth/auth';
import { machineLogbookKeys, machineTypesQuery, organizationsQuery, pricingQuery } from './queries';

type OrganizationFields = { name: string; kind: OrganizationKind; active: boolean };
type GroupFields = { name: string; description: string; isDefault: boolean; active: boolean };
type RuleFields = {
  groupId: string;
  kind: PricingRuleKind;
  machineTypeId: string;
  materialCategory: string;
  materialUnit: 'g' | 'm' | 'ml' | 'm2' | 'piece';
  rate: string;
  active: boolean;
};

export function ConfigurationPage() {
  const currentUser = useCurrentUser();
  const canManageOrganizations = hasPermission(currentUser, PermissionId.organizationsmanage);
  const canManagePricing = hasPermission(currentUser, PermissionId.pricingmanage);
  const client = useQueryClient();
  const organizations = useQuery(organizationsQuery({ page: 1, pageSize: 100 }));
  const pricing = useQuery(pricingQuery());
  const machineTypes = useQuery(machineTypesQuery());
  const [organizationOpen, setOrganizationOpen] = useState(false);
  const [groupOpen, setGroupOpen] = useState(false);
  const [ruleOpen, setRuleOpen] = useState(false);
  const [editingOrganization, setEditingOrganization] = useState<Organization | null>(null);
  const [editingGroup, setEditingGroup] = useState<PricingGroup | null>(null);
  const [editingRule, setEditingRule] = useState<PricingRule | null>(null);
  const organizationForm = useForm<OrganizationFields>({ defaultValues: { kind: 'company', active: true } });
  const groupForm = useForm<GroupFields>({ defaultValues: { isDefault: false, active: true } });
  const ruleForm = useForm<RuleFields>({ defaultValues: { kind: 'machine_runtime', materialUnit: 'g', active: true } });
  const kind = ruleForm.watch('kind');
  const refresh = () => client.invalidateQueries({ queryKey: machineLogbookKeys.all });
  const closeOrganization = () => { setOrganizationOpen(false); setEditingOrganization(null); };
  const closeGroup = () => { setGroupOpen(false); setEditingGroup(null); };
  const closeRule = () => { setRuleOpen(false); setEditingRule(null); };
  const organizationMutation = useMutation({
    mutationFn: (values: OrganizationFields) => editingOrganization
      ? updateOrganization(editingOrganization.id, { ...values, expectedVersion: editingOrganization.version })
      : createOrganization({ name: values.name, kind: values.kind }),
    onSuccess: async () => { closeOrganization(); await refresh(); },
  });
  const groupMutation = useMutation({
    mutationFn: (values: GroupFields) => editingGroup
      ? updatePricingGroup(editingGroup.id, {
        expectedVersion: editingGroup.version,
        name: values.name,
        description: values.description || null,
        active: values.active,
        isDefault: values.isDefault,
      })
      : createPricingGroup({ name: values.name, description: values.description || null, isDefault: values.isDefault }),
    onSuccess: async () => { closeGroup(); await refresh(); },
  });
  const ruleMutation = useMutation({
    mutationFn: (values: RuleFields) => {
      const rule = {
        kind: values.kind,
        machineTypeId: values.kind === 'machine_runtime' ? values.machineTypeId : null,
        materialCategory: values.kind === 'material' ? values.materialCategory.trim().toLowerCase() : null,
        materialUnit: values.kind === 'material' ? values.materialUnit : null,
        rate: values.rate,
      };
      return editingRule
        ? updatePricingRule(editingRule.id, { ...rule, active: values.active, expectedVersion: editingRule.version })
        : createPricingRule(values.groupId, rule);
    },
    onSuccess: async () => { closeRule(); await refresh(); },
  });
  const assignmentMutation = useMutation({
    mutationFn: ({ organizationId, pricingGroupId, expectedVersion }: { organizationId: string; pricingGroupId: string; expectedVersion: number }) =>
      setBillingPartyPricingGroup({ party: { kind: 'organization', id: organizationId }, pricingGroupId: pricingGroupId || null, expectedVersion }),
    onSuccess: refresh,
  });

  const addOrganization = () => {
    setEditingOrganization(null);
    organizationForm.reset({ name: '', kind: 'company', active: true });
    setOrganizationOpen(true);
  };
  const editOrganization = (organization: Organization) => {
    setEditingOrganization(organization);
    organizationForm.reset({ name: organization.name, kind: organization.kind, active: organization.active });
    setOrganizationOpen(true);
  };
  const addGroup = () => {
    setEditingGroup(null);
    groupForm.reset({ name: '', description: '', isDefault: false, active: true });
    setGroupOpen(true);
  };
  const editGroup = (group: PricingGroup) => {
    setEditingGroup(group);
    groupForm.reset({ name: group.name, description: group.description ?? '', isDefault: group.isDefault, active: group.active });
    setGroupOpen(true);
  };
  const addRule = () => {
    setEditingRule(null);
    ruleForm.reset({ groupId: '', kind: 'machine_runtime', machineTypeId: '', materialCategory: '', materialUnit: 'g', rate: '', active: true });
    setRuleOpen(true);
  };
  const editRule = (rule: PricingRule) => {
    setEditingRule(rule);
    ruleForm.reset({
      groupId: rule.pricingGroupId,
      kind: rule.kind,
      machineTypeId: rule.machineTypeId ?? '',
      materialCategory: rule.materialCategory ?? '',
      materialUnit: rule.materialUnit ?? 'g',
      rate: rule.rate,
      active: rule.active,
    });
    setRuleOpen(true);
  };

  if (organizations.isPending || pricing.isPending || machineTypes.isPending) return <FullPageLoading label="Loading machine logbook configuration" />;
  if (organizations.isError || pricing.isError || machineTypes.isError) return <ErrorState message="Configuration could not be loaded." onRetry={() => { organizations.refetch(); pricing.refetch(); machineTypes.refetch(); }} />;

  return <Stack gap={7} className="machine-logbook-page">
    <PageHeader title="Machine logbook configuration" description="Organizations, pricing groups, and explicit rates." breadcrumbs={[{ label: 'Settings', to: '/settings' }, { label: 'Machine logbook' }]} />
    <Tabs>
      <TabList aria-label="Configuration sections"><Tab>Organizations</Tab><Tab>Pricing groups</Tab></TabList>
      <TabPanels>
        <TabPanel>
          <Stack gap={5}>
            <div className="section-heading">
              <div><h2>Organizations</h2><p className="section-description">Active organizations can be selected as billing parties.</p></div>
              {canManageOrganizations && <Button renderIcon={Add} onClick={addOrganization}>Add organization</Button>}
            </div>
            <div className="configuration-list">
              {organizations.data.items.map((organization) => <Tile key={organization.id}>
                <div className="section-heading">
                  <div><h3>{organization.name}</h3><p>{organization.kind} · {organization.active ? 'Active' : 'Inactive'}</p></div>
                  <div className="button-cluster">
                    {canManageOrganizations && <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => editOrganization(organization)}>Edit</Button>}
                    <Select
                      id={`organization-pricing-${organization.id}`}
                      labelText="Default pricing group"
                      value={organization.pricingGroup?.id ?? ''}
                      disabled={!canManagePricing || assignmentMutation.isPending}
                      onChange={(event) => assignmentMutation.mutate({ organizationId: organization.id, pricingGroupId: event.target.value, expectedVersion: organization.pricingGroupAssignmentVersion })}
                    >
                      <SelectItem value="" text="Use global default" />
                      {pricing.data.items.filter((group) => group.active).map((group) => <SelectItem key={group.id} value={group.id} text={group.name} />)}
                    </Select>
                  </div>
                </div>
              </Tile>)}
            </div>
          </Stack>
        </TabPanel>
        <TabPanel>
          <Stack gap={5}>
            <div className="section-heading">
              <div><h2>Pricing groups</h2><p className="section-description">Rates are exact decimals. An explicit zero rate means intentionally free.</p></div>
              {canManagePricing && <div className="button-cluster"><Button kind="secondary" onClick={addRule}>Add rule</Button><Button renderIcon={Add} onClick={addGroup}>Add group</Button></div>}
            </div>
            <div className="configuration-list">
              {pricing.data.items.map((group) => <Tile key={group.id}>
                <div className="section-heading">
                  <div><h3>{group.name}</h3><p>{group.isDefault ? 'Global default · ' : ''}{group.active ? 'Active' : 'Inactive'}{group.description ? ` · ${group.description}` : ''}</p></div>
                  {canManagePricing && <Button kind="ghost" size="sm" renderIcon={Edit} onClick={() => editGroup(group)}>Edit group</Button>}
                </div>
                {group.rules.length === 0
                  ? <p className="section-description">No rules. Jobs resolving to this group will have incomplete pricing.</p>
                  : <table className="configuration-table">
                    <thead><tr><th>Kind</th><th>Selector</th><th>Rate</th><th>Status</th>{canManagePricing && <th>Actions</th>}</tr></thead>
                    <tbody>{group.rules.map((rule) => <tr key={rule.id}>
                      <td>{rule.kind.replace('_', ' ')}</td>
                      <td>{rule.machineTypeId ? machineTypes.data.items.find((type) => type.id === rule.machineTypeId)?.name ?? rule.machineTypeId : `${rule.materialCategory} (${rule.materialUnit})`}</td>
                      <td>€ {rule.rate} / {rule.kind === 'machine_runtime' ? 'h' : rule.materialUnit}</td>
                      <td>{rule.active ? 'Active' : 'Inactive'}</td>
                      {canManagePricing && <td><Button hasIconOnly kind="ghost" size="sm" renderIcon={Edit} iconDescription={`Edit rule for ${group.name}`} onClick={() => editRule(rule)} /></td>}
                    </tr>)}</tbody>
                  </table>}
              </Tile>)}
            </div>
          </Stack>
        </TabPanel>
      </TabPanels>
    </Tabs>

    {organizationOpen && <Modal
      open
      modalHeading={editingOrganization ? 'Edit organization' : 'Add organization'}
      primaryButtonText={organizationMutation.isPending ? 'Saving…' : editingOrganization ? 'Save organization' : 'Add organization'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={organizationMutation.isPending}
      onRequestClose={closeOrganization}
      onRequestSubmit={organizationForm.handleSubmit((values) => organizationMutation.mutate(values))}
    >
      <Stack gap={5}>
        <TextInput id="organization-name" labelText="Name" {...organizationForm.register('name', { required: true })} />
        <Select id="organization-kind" labelText="Type" {...organizationForm.register('kind')}>
          <SelectItem value="company" text="Company" /><SelectItem value="institute" text="Institute" /><SelectItem value="association" text="Association" /><SelectItem value="other" text="Other" />
        </Select>
        {editingOrganization && <Controller control={organizationForm.control} name="active" render={({ field }) => <Toggle id="organization-active" labelText="Active" labelA="Inactive" labelB="Active" toggled={field.value} onToggle={field.onChange} />} />}
        {organizationMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Organization not saved" subtitle="It may have changed. Reload and retry with the latest version." />}
      </Stack>
    </Modal>}

    {groupOpen && <Modal
      open
      modalHeading={editingGroup ? 'Edit pricing group' : 'Add pricing group'}
      primaryButtonText={groupMutation.isPending ? 'Saving…' : editingGroup ? 'Save group' : 'Add group'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={groupMutation.isPending}
      onRequestClose={closeGroup}
      onRequestSubmit={groupForm.handleSubmit((values) => groupMutation.mutate(values))}
    >
      <Stack gap={5}>
        <TextInput id="pricing-group-name" labelText="Name" {...groupForm.register('name', { required: true })} />
        <TextArea id="pricing-group-description" labelText="Description" {...groupForm.register('description')} />
        <Controller control={groupForm.control} name="isDefault" render={({ field }) => <Toggle id="pricing-group-default" labelText="Global default" labelA="No" labelB="Yes" toggled={field.value} onToggle={field.onChange} />} />
        {editingGroup && <Controller control={groupForm.control} name="active" render={({ field }) => <Toggle id="pricing-group-active" labelText="Active" labelA="Inactive" labelB="Active" toggled={field.value} onToggle={field.onChange} />} />}
        {groupMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Pricing group not saved" subtitle="It may have changed. Reload and retry with the latest version." />}
      </Stack>
    </Modal>}

    {ruleOpen && <Modal
      open
      modalHeading={editingRule ? 'Edit pricing rule' : 'Add pricing rule'}
      primaryButtonText={ruleMutation.isPending ? 'Saving…' : editingRule ? 'Save rule' : 'Add rule'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={ruleMutation.isPending}
      onRequestClose={closeRule}
      onRequestSubmit={ruleForm.handleSubmit((values) => ruleMutation.mutate(values))}
    >
      <Stack gap={5}>
        <Select id="rule-group" labelText="Pricing group" disabled={Boolean(editingRule)} {...ruleForm.register('groupId', { required: true })}>
          <SelectItem value="" text="Select a group" />
          {pricing.data.items.filter((group) => group.active).map((group) => <SelectItem key={group.id} value={group.id} text={group.name} />)}
        </Select>
        <Select id="rule-kind" labelText="Rule kind" {...ruleForm.register('kind')}>
          <SelectItem value="machine_runtime" text="Machine runtime" /><SelectItem value="material" text="Material" />
        </Select>
        {kind === 'machine_runtime'
          ? <Select id="rule-machine-type" labelText="Machine type" {...ruleForm.register('machineTypeId', { required: true })}>
            <SelectItem value="" text="Select a type" />{machineTypes.data.items.filter((type) => type.active).map((type) => <SelectItem key={type.id} value={type.id} text={type.name} />)}
          </Select>
          : <>
            <TextInput id="rule-material-category" labelText="Normalized material category" {...ruleForm.register('materialCategory', { required: true })} />
            <Select id="rule-material-unit" labelText="Unit" {...ruleForm.register('materialUnit')}>
              <SelectItem value="g" text="g" /><SelectItem value="m" text="m" /><SelectItem value="ml" text="ml" /><SelectItem value="m2" text="m²" /><SelectItem value="piece" text="piece" />
            </Select>
          </>}
        <TextInput id="rule-rate" labelText={`Rate (€ per ${kind === 'machine_runtime' ? 'hour' : 'unit'})`} {...ruleForm.register('rate', { required: true })} />
        {editingRule && <Controller control={ruleForm.control} name="active" render={({ field }) => <Toggle id="pricing-rule-active" labelText="Active" labelA="Inactive" labelB="Active" toggled={field.value} onToggle={field.onChange} />} />}
        {ruleMutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Pricing rule not saved" subtitle="It may have changed. Reload and retry with the latest version." />}
      </Stack>
    </Modal>}
  </Stack>;
}
