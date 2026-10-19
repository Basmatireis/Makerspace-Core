import { InlineNotification, Modal, Select, SelectItem, Stack, TextInput } from '@carbon/react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { createOrganization } from '../../api/generated/organizations/organizations';
import type { Organization, OrganizationKind } from '../../api/generated/models';
import { machineLogbookKeys } from '../machinelogbook/queries';
import { organizationKeys } from './queries';
import { organizationKindLabels, organizationKinds } from './presentation';

type Fields = { name: string; kind: OrganizationKind };

export function OrganizationFormModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (organization: Organization) => void }) {
  const client = useQueryClient();
  const form = useForm<Fields>({ defaultValues: { name: '', kind: 'company' } });
  const mutation = useMutation({
    mutationFn: (values: Fields) => createOrganization({ name: values.name.trim(), kind: values.kind }),
    onSuccess: async (organization) => {
      await Promise.all([client.invalidateQueries({ queryKey: organizationKeys.all }), client.invalidateQueries({ queryKey: machineLogbookKeys.all })]);
      form.reset();
      onCreated(organization);
    },
  });
  const close = () => { if (!mutation.isPending) { form.reset(); mutation.reset(); onClose(); } };
  return (
    <Modal
      open={open}
      preventCloseOnClickOutside
      modalHeading="New organization"
      primaryButtonText={mutation.isPending ? 'Saving…' : 'Create organization'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={mutation.isPending}
      onRequestClose={close}
      onRequestSubmit={form.handleSubmit((values) => { if (!mutation.isPending) mutation.mutate(values); })}
    >
      <Stack gap={5}>
        <p className="section-description">Address, contact and members can be added on the organization page.</p>
        <TextInput
          id="organization-create-name" labelText="Name" invalid={Boolean(form.formState.errors.name)} invalidText="Enter a name."
          {...form.register('name', { validate: (value) => value.trim().length > 0 })}
        />
        <Select id="organization-create-kind" labelText="Kind" {...form.register('kind')}>
          {organizationKinds.map((kind) => <SelectItem key={kind} value={kind} text={organizationKindLabels[kind]} />)}
        </Select>
        {mutation.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Organization not created" subtitle="The name may already be in use." />}
      </Stack>
    </Modal>
  );
}
