import './organizations.scss';
import { useState } from 'react';
import {
  Button, ComboBox, InlineNotification, Link as CarbonLink, Select, SelectItem, Stack, StructuredListBody, StructuredListCell, StructuredListHead,
  StructuredListRow, StructuredListWrapper, Tag, TextInput, Toggle,
} from '@carbon/react';
import { Add, TrashCan } from '@carbon/icons-react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm } from 'react-hook-form';
import { Link, useParams } from 'react-router-dom';
import type { Organization, OrganizationKind } from '../../api/generated/models';
import {
  addOrganizationMember, removeOrganizationMember, updateOrganization, updateOrganizationInvoicingRequirements,
} from '../../api/generated/organizations/organizations';
import { setBillingPartyPricingGroup } from '../../api/generated/pricing/pricing';
import { DetailSection } from '../../app/DetailSection';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { machineLogbookKeys, pricingQuery } from '../machinelogbook/queries';
import { matchesName } from '../machinelogbook/dialogs/jobFormHelpers';
import { machineLogbookPaths } from '../machinelogbook/shared/paths';
import { QueryBoundary } from '../machinelogbook/shared/QueryBoundary';
import { DeleteOrganizationModal } from './DeleteOrganizationModal';
import { organizationKindLabels, organizationKinds, organizationPaths } from './presentation';
import { memberCandidatesQuery, organizationKeys, organizationMembersQuery, organizationQuery, organizationRequirementsQuery } from './queries';

type MasterFields = { name: string; kind: OrganizationKind; active: boolean };
type InvoiceFields = {
  addressLine: string; postalCode: string; locality: string; countryCode: string;
  contactName: string; contactEmail: string; requirePurchaseOrderReference: boolean;
};

function useRefreshOrganization() {
  const client = useQueryClient();
  return () => Promise.all([
    client.invalidateQueries({ queryKey: organizationKeys.all }),
    client.invalidateQueries({ queryKey: machineLogbookKeys.all }),
  ]);
}

const saveFailed = (title: string) => (
  <InlineNotification kind="error" lowContrast hideCloseButton title={title} subtitle="It may have changed or a value is invalid. Reload and try again." />
);

function MasterDataSection({ organization, canManage }: { organization: Organization; canManage: boolean }) {
  const refresh = useRefreshOrganization();
  const form = useForm<MasterFields>({ defaultValues: { name: organization.name, kind: organization.kind, active: organization.active } });
  const mutation = useMutation({
    mutationFn: (values: MasterFields) => updateOrganization(organization.id, { ...values, name: values.name.trim(), expectedVersion: organization.version }),
    onSuccess: refresh,
  });
  return (
    <DetailSection title="Master data" description="Deactivating an organization removes it from new billing selections. Existing jobs, orders and history remain.">
      <form onSubmit={form.handleSubmit((values) => { if (!mutation.isPending) mutation.mutate(values); })} noValidate>
        <Stack gap={5}>
          <div className="organization-form-grid">
            <TextInput
              id="organization-name" labelText="Name" readOnly={!canManage}
              invalid={Boolean(form.formState.errors.name)} invalidText="Enter a name."
              {...form.register('name', { validate: (value) => value.trim().length > 0 })}
            />
            <Select id="organization-kind" labelText="Kind" disabled={!canManage} {...form.register('kind')}>
              {organizationKinds.map((kind) => <SelectItem key={kind} value={kind} text={organizationKindLabels[kind]} />)}
            </Select>
            <Controller control={form.control} name="active" render={({ field }) => (
              <Toggle id="organization-active" labelText="Status" labelA="Inactive" labelB="Active" readOnly={!canManage} toggled={field.value} onToggle={field.onChange} />
            )} />
          </div>
          {mutation.isError && saveFailed('Master data not saved')}
          {canManage && <div><Button type="submit" disabled={mutation.isPending || !form.formState.isDirty}>{mutation.isPending ? 'Saving…' : 'Save master data'}</Button></div>}
        </Stack>
      </form>
    </DetailSection>
  );
}

function InvoiceDataSection({ organization, canManage, canReadRequirements }: { organization: Organization; canManage: boolean; canReadRequirements: boolean }) {
  const refresh = useRefreshOrganization();
  const requirements = useQuery({ ...organizationRequirementsQuery(organization.id), enabled: canReadRequirements });
  const requirementsVersion = requirements.data?.version;
  return (
    // The form remounts with fresh values whenever a saved version arrives.
    <InvoiceDataForm
      key={`${organization.version}-${requirementsVersion ?? 'none'}`}
      organization={organization}
      canManage={canManage}
      requirePurchaseOrder={requirements.data?.requirePurchaseOrderReference}
      requirementsVersion={requirementsVersion}
      requirementsFailed={canReadRequirements && requirements.isError}
      refresh={refresh}
    />
  );
}

function InvoiceDataForm({ organization, canManage, requirePurchaseOrder, requirementsVersion, requirementsFailed, refresh }: {
  organization: Organization; canManage: boolean; requirePurchaseOrder: boolean | undefined; requirementsVersion: number | undefined;
  requirementsFailed: boolean; refresh: () => Promise<unknown>;
}) {
  const poAvailable = requirementsVersion !== undefined;
  const form = useForm<InvoiceFields>({
    defaultValues: {
      addressLine: organization.addressLine, postalCode: organization.postalCode, locality: organization.locality, countryCode: organization.countryCode,
      contactName: organization.contactName, contactEmail: organization.contactEmail, requirePurchaseOrderReference: requirePurchaseOrder ?? false,
    },
  });
  const mutation = useMutation({
    mutationFn: async (values: InvoiceFields) => {
      const { requirePurchaseOrderReference, ...details } = values;
      await updateOrganization(organization.id, {
        name: organization.name, kind: organization.kind, active: organization.active, expectedVersion: organization.version,
        ...details, countryCode: details.countryCode.trim().toUpperCase(),
      });
      if (poAvailable && requirePurchaseOrderReference !== requirePurchaseOrder) {
        await updateOrganizationInvoicingRequirements(organization.id, { requirePurchaseOrderReference, expectedVersion: requirementsVersion });
      }
    },
    onSettled: refresh,
  });
  const errors = form.formState.errors;
  return (
    <DetailSection title="Invoice data" description="Used to prefill invoice drafts for this organization.">
      <form onSubmit={form.handleSubmit((values) => { if (!mutation.isPending) mutation.mutate(values); })} noValidate>
        <Stack gap={5}>
          <div className="organization-form-grid">
            <div className="organization-form-grid__wide">
              <TextInput id="organization-address" labelText="Address" maxLength={200} readOnly={!canManage} {...form.register('addressLine')} />
            </div>
            <TextInput id="organization-postal-code" labelText="Postal code" maxLength={20} readOnly={!canManage} {...form.register('postalCode')} />
            <TextInput id="organization-locality" labelText="City" maxLength={100} readOnly={!canManage} {...form.register('locality')} />
            <TextInput
              id="organization-country" labelText="Country code" helperText="Two letters, for example AT or DE." maxLength={2} readOnly={!canManage}
              invalid={Boolean(errors.countryCode)} invalidText="Use a two-letter country code."
              {...form.register('countryCode', { validate: (value) => value === '' || /^[A-Za-z]{2}$/.test(value.trim()) })}
            />
            <TextInput id="organization-contact-name" labelText="Contact person" maxLength={200} readOnly={!canManage} {...form.register('contactName')} />
            <TextInput
              id="organization-contact-email" labelText="Contact email" type="email" maxLength={254} readOnly={!canManage}
              invalid={Boolean(errors.contactEmail)} invalidText="Enter a plain email address."
              {...form.register('contactEmail', { validate: (value) => value === '' || /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim()) })}
            />
          </div>
          {poAvailable && (
            <Controller control={form.control} name="requirePurchaseOrderReference" render={({ field }) => (
              <Toggle
                id="organization-po-required" labelText="Purchase order number required" labelA="Not required" labelB="Required" readOnly={!canManage}
                toggled={field.value} onToggle={field.onChange}
              />
            )} />
          )}
          {requirementsFailed && <InlineNotification kind="warning" lowContrast hideCloseButton title="Purchase order setting unavailable" subtitle="It could not be loaded; the other invoice data can still be saved." />}
          {mutation.isError && saveFailed('Invoice data not saved')}
          {canManage && <div><Button type="submit" disabled={mutation.isPending || !form.formState.isDirty}>{mutation.isPending ? 'Saving…' : 'Save invoice data'}</Button></div>}
        </Stack>
      </form>
    </DetailSection>
  );
}

function PricingGroupSection({ organization, canRead, canManage }: { organization: Organization; canRead: boolean; canManage: boolean }) {
  const refresh = useRefreshOrganization();
  const pricing = useQuery({ ...pricingQuery(), enabled: canRead });
  const mutation = useMutation({
    mutationFn: (pricingGroupId: string) => setBillingPartyPricingGroup({
      party: { kind: 'organization', id: organization.id }, pricingGroupId: pricingGroupId || null, expectedVersion: organization.pricingGroupAssignmentVersion,
    }),
    onSettled: refresh,
  });
  const groups = (pricing.data?.items ?? []).filter((group) => group.active || group.id === organization.pricingGroup?.id);
  return (
    <DetailSection title="Pricing group" description="Jobs for this organization are priced from this group unless a job overrides it.">
      {canRead && pricing.data ? (
        <Select
          id="organization-pricing-group" labelText="Pricing group" value={organization.pricingGroup?.id ?? ''}
          disabled={!canManage || mutation.isPending} onChange={(event) => mutation.mutate(event.target.value)}
        >
          <SelectItem value="" text="Use global default" />
          {groups.map((group) => <SelectItem key={group.id} value={group.id} text={group.name} />)}
        </Select>
      ) : <p>{organization.pricingGroup?.name ?? 'Global default'}</p>}
      {canRead && pricing.isError && <InlineNotification kind="warning" lowContrast hideCloseButton title="Pricing groups unavailable" subtitle="The current group is shown but cannot be changed right now." />}
      {mutation.isError && saveFailed('Pricing group not saved')}
    </DetailSection>
  );
}

function MembersSection({ organization, canManage, canOpenPeople }: { organization: Organization; canManage: boolean; canOpenPeople: boolean }) {
  const refresh = useRefreshOrganization();
  const members = useQuery(organizationMembersQuery(organization.id));
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<{ id: string; displayName: string } | null>(null);
  const candidates = useQuery({ ...memberCandidatesQuery(search), enabled: canManage, placeholderData: keepPreviousData });
  const memberIds = new Set((members.data?.items ?? []).map((member) => member.personId));
  const people = (candidates.data?.items ?? []).filter((party) => party.kind === 'person' && !memberIds.has(party.id));
  const add = useMutation({
    mutationFn: (personId: string) => addOrganizationMember(organization.id, { personId }),
    onSuccess: async () => { setSelected(null); setSearch(''); await refresh(); },
  });
  const remove = useMutation({
    mutationFn: (personId: string) => removeOrganizationMember(organization.id, personId),
    onSettled: refresh,
  });
  return (
    <DetailSection
      title="People" description="People associated with this organization. Anyone may still order for it; this list helps find the right organization when creating a job."
    >
      <QueryBoundary query={members} errorMessage="People could not be loaded.">
        {(data) => data.items.length === 0 ? <p className="section-description">No people are associated yet.</p> : (
          <StructuredListWrapper aria-label="People in this organization">
            <StructuredListHead>
              <StructuredListRow head>
                <StructuredListCell head>Name</StructuredListCell>
                {canManage && <StructuredListCell head><span className="cds--visually-hidden">Actions</span></StructuredListCell>}
              </StructuredListRow>
            </StructuredListHead>
            <StructuredListBody>
              {data.items.map((member) => (
                <StructuredListRow key={member.personId}>
                  <StructuredListCell>
                    {canOpenPeople ? <CarbonLink as={Link} to={`/people/${member.personId}`}>{member.displayName}</CarbonLink> : member.displayName}
                  </StructuredListCell>
                  {canManage && (
                    <StructuredListCell>
                      <Button
                        hasIconOnly kind="ghost" size="sm" renderIcon={TrashCan} iconDescription={`Remove ${member.displayName}`} tooltipPosition="left"
                        disabled={remove.isPending} onClick={() => remove.mutate(member.personId)}
                      />
                    </StructuredListCell>
                  )}
                </StructuredListRow>
              ))}
            </StructuredListBody>
          </StructuredListWrapper>
        )}
      </QueryBoundary>
      {canManage && (
        <div className="organization-member-add">
          <ComboBox
            id="organization-member-search" titleText="Add person" placeholder="Search people" items={people}
            itemToString={(item) => item?.displayName ?? ''} shouldFilterItem={matchesName} selectedItem={selected}
            onInputChange={setSearch} onChange={({ selectedItem }) => setSelected(selectedItem ? { id: selectedItem.id, displayName: selectedItem.displayName } : null)}
          />
          <Button renderIcon={Add} disabled={!selected || add.isPending} onClick={() => selected && add.mutate(selected.id)}>Add person</Button>
        </div>
      )}
      {candidates.isError && <InlineNotification kind="warning" lowContrast hideCloseButton title="People search unavailable" subtitle="Try again in a moment." />}
      {add.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Person not added" subtitle="The person may already be associated or no longer exist." />}
      {remove.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Person not removed" subtitle="Reload the organization and try again." />}
    </DetailSection>
  );
}

function DeleteSection({ organization }: { organization: Organization }) {
  const [open, setOpen] = useState(false);
  return (
    <DetailSection title="Delete organization" description="Permanently deletes the organization. This is only possible while no jobs, orders or invoice requests refer to it; deactivate it otherwise.">
      <div><Button kind="danger--tertiary" renderIcon={TrashCan} onClick={() => setOpen(true)}>Delete organization</Button></div>
      <DeleteOrganizationModal organization={organization} open={open} onClose={() => setOpen(false)} />
    </DetailSection>
  );
}

export function OrganizationDetailPage() {
  const { organizationId = '' } = useParams();
  const currentUser = useCurrentUser();
  const can = (permission: PermissionId) => hasPermission(currentUser, permission);
  const canManage = can(PermissionId.organizationsmanage);
  const query = useQuery(organizationQuery(organizationId));
  const organization = query.data;
  return (
    <PageShell
      title={organization?.name ?? 'Organization'}
      titleAdornment={organization && <Tag size="sm" type={organization.active ? 'green' : 'gray'}>{organization.active ? 'Active' : 'Inactive'}</Tag>}
      description={organization ? `${organizationKindLabels[organization.kind]} · ${organization.memberCount} associated ${organization.memberCount === 1 ? 'person' : 'people'}` : undefined}
      breadcrumbs={[{ label: 'Directory' }, { label: 'Organizations', to: organizationPaths.list() }]}
    >
      <QueryBoundary query={query} errorMessage="The organization could not be loaded.">
        {(data) => (
          <Stack gap={6}>
            <MasterDataSection key={`master-${data.version}`} organization={data} canManage={canManage} />
            <InvoiceDataSection organization={data} canManage={canManage} canReadRequirements={can(PermissionId.ordersread)} />
            <PricingGroupSection organization={data} canRead={can(PermissionId.pricingread)} canManage={can(PermissionId.pricingmanage)} />
            <MembersSection organization={data} canManage={canManage} canOpenPeople={can(PermissionId.peoplereadall)} />
            {can(PermissionId.machine_jobsread) && (
              <DetailSection title="Jobs" description="Machine jobs billed to this organization.">
                <div><Button as={Link} to={machineLogbookPaths.jobs({ customer: data.id })} kind="tertiary">Show jobs</Button></div>
              </DetailSection>
            )}
            {canManage && <DeleteSection organization={data} />}
          </Stack>
        )}
      </QueryBoundary>
    </PageShell>
  );
}
