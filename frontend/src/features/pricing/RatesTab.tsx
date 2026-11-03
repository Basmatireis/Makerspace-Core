import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import {
  Button,
  IconButton,
  InlineNotification,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableHeader,
  TableRow,
  Tag,
  TextArea,
  TextInput,
  Toggle,
} from '@carbon/react';
import { Add, Edit } from '@carbon/icons-react';
import { useMutation } from '@tanstack/react-query';
import { createPricingGroup, updatePricingGroup } from '../../api/generated/pricing/pricing';
import type { PricingGroup } from '../../api/generated/models';
import { CatalogFormModal as Modal } from '../machinelogbook/CatalogFormModal';
import { RatesTable } from './RatesTable';
import { pricingGaps, type RateSelector } from './selectors';
import { useRefresh } from './pricingShared';

type GroupFields = { name: string; description: string; isDefault: boolean; active: boolean };

function GroupModal({ group, onClose }: { group: PricingGroup | null; onClose: () => void }) {
  const refresh = useRefresh();
  const form = useForm<GroupFields>({
    defaultValues: group
      ? { name: group.name, description: group.description ?? '', isDefault: group.isDefault, active: group.active }
      : { name: '', description: '', isDefault: false, active: true },
  });
  const mutation = useMutation({
    mutationFn: (values: GroupFields) =>
      group
        ? updatePricingGroup(group.id, {
            expectedVersion: group.version,
            name: values.name.trim(),
            description: values.description || null,
            active: values.active,
            isDefault: values.isDefault,
          })
        : createPricingGroup({
            name: values.name.trim(),
            description: values.description || null,
            isDefault: values.isDefault,
          }),
    onSuccess: async () => {
      await refresh();
      onClose();
    },
  });
  return (
    <Modal
      open
      preventCloseOnClickOutside
      modalHeading={group ? 'Edit pricing group' : 'New pricing group'}
      primaryButtonText={mutation.isPending ? 'Saving…' : group ? 'Save group' : 'Add group'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      onRequestClose={() => {
        if (!mutation.isPending) onClose();
      }}
      onRequestSubmit={form.handleSubmit((values) => mutation.mutate(values))}
    >
      <Stack gap={5}>
        <TextInput
          id="pricing-group-name"
          labelText="Name"
          invalid={!!form.formState.errors.name}
          invalidText="Enter a name"
          {...form.register('name', { validate: (value) => value.trim() !== '' })}
        />
        <TextArea id="pricing-group-description" labelText="Description" {...form.register('description')} />
        <Controller
          control={form.control}
          name="isDefault"
          render={({ field }) => (
            <Toggle
              id="pricing-group-default"
              labelText="Default group"
              labelA="No"
              labelB="Yes"
              toggled={field.value}
              onToggle={field.onChange}
            />
          )}
        />
        {group && (
          <Controller
            control={form.control}
            name="active"
            render={({ field }) => (
              <Toggle
                id="pricing-group-active"
                labelText="Active"
                labelA="Inactive"
                labelB="Active"
                toggled={field.value}
                onToggle={field.onChange}
              />
            )}
          />
        )}
        {group && (
          <p className="mj-secondary">
            Inactive groups are unavailable for new pricing. Existing price snapshots remain unchanged.
          </p>
        )}
        {mutation.isError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Pricing group not saved"
            subtitle={mutation.error.message}
          />
        )}
      </Stack>
    </Modal>
  );
}

export function RatesTab({
  groups,
  selectors,
  canEdit,
  partial,
}: {
  groups: PricingGroup[];
  selectors: RateSelector[];
  canEdit: boolean;
  partial: boolean;
}) {
  const [editing, setEditing] = useState<PricingGroup | 'new' | null>(null);
  const gaps = pricingGaps(groups, selectors);
  return (
    <Stack gap={7}>
      {gaps.length > 0 && (
        <InlineNotification
          kind="warning"
          lowContrast
          hideCloseButton
          title={`${gaps.length} ${gaps.length === 1 ? 'rate is' : 'rates are'} missing`}
          subtitle={`Jobs that need ${gaps.length === 1 ? 'it' : 'them'} cannot be priced: ${gaps
            .slice(0, 3)
            .map((gap) => `${gap.selector.label.toLowerCase()} for ${gap.group.name}`)
            .join(', ')}${gaps.length > 3 ? ` and ${gaps.length - 3} more` : ''}.`}
        />
      )}
      {partial && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Some rates are not shown"
          subtitle="Processes need the permission to read machines, material types the permission to read inventory."
        />
      )}
      <RatesTable groups={groups} selectors={selectors} canEdit={canEdit} />
      <TableContainer
        title="Pricing groups"
        description="A job is priced with the group set on the job, else the group of its organization, else the group mapped to the customer's highest-priority role, else the default group."
      >
        {canEdit && (
          <div className="sales-section-actions">
            <Button kind="primary" size="md" renderIcon={Add} onClick={() => setEditing('new')}>
              New group
            </Button>
          </div>
        )}
        <Table aria-label="Pricing groups">
          <TableHead>
            <TableRow>
              <TableHeader>Group</TableHeader>
              <TableHeader className="mj-hide-narrow">Description</TableHeader>
              <TableHeader>Status</TableHeader>
              <TableHeader className="mj-hide-narrow">Rates</TableHeader>
              <TableHeader>
                <span className="cds--visually-hidden">Actions</span>
              </TableHeader>
            </TableRow>
          </TableHead>
          <TableBody>
            {groups.map((group) => {
              const missing = group.active ? gaps.filter((gap) => gap.group.id === group.id).length : 0;
              return (
                <TableRow key={group.id}>
                  <TableCell>
                    <span className="mj-inline">
                      <strong>{group.name}</strong>
                      {group.isDefault && (
                        <Tag type="blue" size="sm">
                          Default
                        </Tag>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="mj-hide-narrow">
                    {group.description || <span className="mj-secondary">—</span>}
                  </TableCell>
                  <TableCell>
                    <Tag type={group.active ? 'green' : 'warm-gray'} size="sm">
                      {group.active ? 'Active' : 'Inactive'}
                    </Tag>
                  </TableCell>
                  <TableCell className="mj-hide-narrow">
                    {missing > 0 ? (
                      <Tag type="red" size="sm">
                        {missing} missing
                      </Tag>
                    ) : group.active ? (
                      <Tag type="green" size="sm">
                        Complete
                      </Tag>
                    ) : (
                      '—'
                    )}
                  </TableCell>
                  <TableCell className="sales-row-actions">
                    {canEdit && (
                      <IconButton label={`Edit ${group.name}`} kind="ghost" size="sm" onClick={() => setEditing(group)}>
                        <Edit />
                      </IconButton>
                    )}
                  </TableCell>
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
