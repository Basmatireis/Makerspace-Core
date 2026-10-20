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
import { Add, Checkmark, Close, Edit } from '@carbon/icons-react';
import { useMutation } from '@tanstack/react-query';
import {
  createPricingGroup,
  createPricingRule,
  updatePricingGroup,
  updatePricingRule,
} from '../../api/generated/pricing/pricing';
import type { PricingGroup } from '../../api/generated/models';
import { CatalogFormModal as Modal } from '../machinelogbook/CatalogFormModal';
import { parseDecimalInput } from '../orders/money';
import { pricingGaps, ruleOf, type RateSelector } from './selectors';
import { rateText, useRefresh } from './pricingShared';

function RateCell({ group, selector, canEdit }: { group: PricingGroup; selector: RateSelector; canEdit: boolean }) {
  const refresh = useRefresh();
  const rule = ruleOf(group, selector);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const parsed = parseDecimalInput(text);
  const mutation = useMutation({
    mutationFn: () => {
      const target = {
        kind: selector.kind,
        machineTypeId: selector.machineTypeId ?? null,
        materialTypeId: selector.materialTypeId ?? null,
        measure: selector.measure ?? null,
        rate: parsed!,
      };
      return rule
        ? updatePricingRule(rule.id, { ...target, active: true, expectedVersion: rule.version })
        : createPricingRule(group.id, target);
    },
    onSuccess: async () => {
      setEditing(false);
      await refresh();
    },
  });
  const open = () => {
    mutation.reset();
    setText(rule ? rateText(rule.rate) : '');
    setEditing(true);
  };
  if (editing) {
    return (
      <div className="sales-rate-edit">
        <TextInput
          id={`rate-${group.id}-${selector.key}`}
          labelText={`Rate for ${selector.label} in ${group.name}`}
          hideLabel
          size="sm"
          inputMode="decimal"
          value={text}
          autoFocus
          invalid={(text !== '' && parsed === null) || mutation.isError}
          invalidText={mutation.error?.message ?? 'e.g. 0,08'}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && parsed !== null) mutation.mutate();
            if (event.key === 'Escape') setEditing(false);
          }}
        />
        <IconButton
          label="Save rate"
          kind="ghost"
          size="sm"
          disabled={parsed === null || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          <Checkmark />
        </IconButton>
        <IconButton label="Discard" kind="ghost" size="sm" onClick={() => setEditing(false)}>
          <Close />
        </IconButton>
      </div>
    );
  }
  return (
    <div className="sales-rate">
      {rule ? (
        <span className="sales-num">
          {rateText(rule.rate)} <span className="mj-secondary">{selector.unit}</span>
        </span>
      ) : (
        <Tag type="red" size="sm">
          Missing
        </Tag>
      )}
      {canEdit &&
        (rule ? (
          <IconButton label={`Edit ${selector.label} for ${group.name}`} kind="ghost" size="sm" onClick={open}>
            <Edit />
          </IconButton>
        ) : (
          <Button kind="ghost" size="sm" renderIcon={Add} onClick={open}>
            Set rate
          </Button>
        ))}
    </div>
  );
}

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
  const active = groups.filter((group) => group.active);
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
          subtitle="Machine types need the permission to read machines, material types the permission to read inventory."
        />
      )}
      <TableContainer
        title="Rates"
        description={
          canEdit
            ? 'Each cell is the price of one hour of machine time, a measure block or one unit of material. An explicit 0 means free.'
            : 'Each cell is the price of one hour of machine time, a measure block or one unit of material.'
        }
      >
        <Table aria-label="Rates by pricing group" className="sales-rates">
          <TableHead>
            <TableRow>
              <TableHeader>Rate</TableHeader>
              {active.map((group) => (
                <TableHeader key={group.id}>
                  {group.name}
                  {group.isDefault && (
                    <>
                      {' '}
                      <Tag type="blue" size="sm">
                        Default
                      </Tag>
                    </>
                  )}
                </TableHeader>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {selectors.length === 0 && (
              <TableRow>
                <TableCell colSpan={active.length + 1}>No machine or material types to price yet.</TableCell>
              </TableRow>
            )}
            {selectors.map((selector) => (
              <TableRow key={selector.key}>
                <TableCell>
                  <div className="mj-cell-stack">
                    <strong>{selector.label}</strong>
                    <span className="mj-secondary">{selector.description}</span>
                  </div>
                </TableCell>
                {active.map((group) => (
                  <TableCell key={group.id}>
                    <RateCell group={group} selector={selector} canEdit={canEdit} />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
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
