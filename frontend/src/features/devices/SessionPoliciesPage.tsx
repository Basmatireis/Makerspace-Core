import {
  Button,
  Checkbox,
  ComposedModal,
  Form,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  NumberInput,
  Select,
  SelectItem,
  Stack,
  Tag,
  TextInput,
} from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  createSessionPolicy,
  listSessionPolicies,
  updateSessionPolicy,
} from '../../api/generated/managed-devices/managed-devices';
import type { PostSessionDestination, SessionPolicy, SessionPolicyInput } from '../../api/generated/models';
import { ErrorState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { DirectoryTable, type Column } from '../machinelogbook/shared/DirectoryTable';
import { SettingsLoading, SettingsSection } from '../settings/SettingsPageLayout';
import { keys } from './components/deviceShared';
import { useAllManagedDevices } from './queries';

const destinationLabels: Record<PostSessionDestination, string> = {
  login: 'Sign in',
  visitor_terminal: 'Public kiosk',
};

export function SessionPoliciesPanel() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const canReadDevices = hasPermission(currentUser, PermissionId.managed_devicesread);
  const query = useQuery({ queryKey: keys.policies, queryFn: ({ signal }) => listSessionPolicies({ signal }) });
  const { devices } = useAllManagedDevices(canReadDevices);
  // `null` closes the modal, `'new'` creates a policy.
  const [editing, setEditing] = useState<SessionPolicy | 'new' | null>(null);
  const [saved, setSaved] = useState(false);

  const usage = (policy: SessionPolicy) => devices?.filter((device) => device.sessionPolicyId === policy.id).length;
  const columns: Column<SessionPolicy>[] = [
    {
      key: 'name',
      header: 'Policy',
      sortValue: (policy) => policy.name.toLowerCase(),
      render: (policy) => (
        <div className="mj-cell-stack">
          <Button kind="ghost" size="sm" onClick={() => setEditing(policy)}>
            {policy.name}
          </Button>
        </div>
      ),
    },
    {
      key: 'idle',
      header: 'Idle timeout',
      narrow: true,
      sortValue: (policy) => policy.idleTimeoutSeconds,
      render: (policy) => duration(policy.idleTimeoutSeconds),
    },
    {
      key: 'absolute',
      header: 'Absolute lifetime',
      narrow: true,
      sortValue: (policy) => policy.absoluteLifetimeSeconds,
      render: (policy) => duration(policy.absoluteLifetimeSeconds),
    },
    {
      key: 'destination',
      header: 'After expiry',
      narrow: true,
      sortValue: (policy) => policy.postSessionDestination,
      render: (policy) => destinationLabels[policy.postSessionDestination],
    },
    {
      key: 'default',
      header: 'Default',
      sortValue: (policy) => Number(policy.isDefault),
      render: (policy) =>
        policy.isDefault ? (
          <Tag size="sm" type="blue">
            Default
          </Tag>
        ) : (
          <span className="mj-secondary">No</span>
        ),
    },
    ...(canReadDevices
      ? [
          {
            key: 'devices',
            header: 'Devices',
            narrow: true,
            sortValue: (policy: SessionPolicy) => usage(policy) ?? 0,
            render: (policy: SessionPolicy) => usage(policy) ?? '…',
          },
        ]
      : []),
  ];

  return (
    <SettingsSection
      title="Session policies"
      description="Control idle and absolute session limits for private and registered devices."
    >
      {saved && (
        <InlineNotification
          kind="success"
          lowContrast
          title="Policy saved"
          subtitle="The new limits apply to new sessions."
          onCloseButtonClick={() => setSaved(false)}
        />
      )}
      {query.isPending && <SettingsLoading label="Loading session policies" />}
      {query.isError && (
        <ErrorState
          title="Unable to load session policies"
          message="Check the connection and try again."
          onRetry={() => void query.refetch()}
        />
      )}
      {query.data && (
        <DirectoryTable<SessionPolicy>
          id="policies"
          urlPrefix="pol-"
          label="Session policies"
          columns={columns}
          rows={query.data.items}
          totalCount={query.data.items.length}
          searchText={(policy) => policy.name}
          defaultSort={{ key: 'name', direction: 'ASC' }}
          onRowClick={setEditing}
          toolbarAction={
            <Button kind="primary" size="lg" onClick={() => setEditing('new')}>
              New policy
            </Button>
          }
          empty={{ title: 'No session policies', description: 'Create a policy to set session limits for devices.' }}
        />
      )}
      {editing && (
        <PolicyModal
          policy={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            setSaved(true);
            await queryClient.invalidateQueries({ queryKey: keys.policies });
          }}
        />
      )}
    </SettingsSection>
  );
}

function PolicyModal({
  policy,
  onClose,
  onSaved,
}: {
  policy: SessionPolicy | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(policy?.name ?? '');
  const [idle, setIdle] = useState(policy?.idleTimeoutSeconds ?? 2700);
  const [absolute, setAbsolute] = useState(policy?.absoluteLifetimeSeconds ?? 43200);
  const [destination, setDestination] = useState<PostSessionDestination>(policy?.postSessionDestination ?? 'login');
  const [isDefault, setDefault] = useState(policy?.isDefault ?? false);
  const mutation = useMutation({
    mutationFn: (input: SessionPolicyInput) =>
      policy
        ? updateSessionPolicy(policy.id, { ...input, expectedVersion: policy.version })
        : createSessionPolicy(input),
    onSuccess: onSaved,
  });
  const invalid = !name.trim() || idle > absolute || mutation.isPending;
  const submit = () =>
    mutation.mutate({
      name: name.trim(),
      idleTimeoutSeconds: idle,
      absoluteLifetimeSeconds: absolute,
      postSessionDestination: destination,
      isDefault,
    });
  return (
    <ComposedModal open onClose={onClose}>
      <ModalHeader title={policy ? 'Edit session policy' : 'New session policy'} />
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid) submit();
        }}
      >
        <ModalBody hasForm>
          <Stack gap={5}>
            <TextInput
              id="policy-name"
              labelText="Name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <NumberInput
              id="policy-idle"
              label="Idle timeout in seconds"
              min={60}
              max={2592000}
              value={idle}
              invalid={idle > absolute}
              invalidText="The idle timeout cannot exceed the absolute lifetime."
              onChange={(_event, state) => setIdle(Number(state.value))}
            />
            <NumberInput
              id="policy-absolute"
              label="Absolute lifetime in seconds"
              min={300}
              max={7776000}
              value={absolute}
              onChange={(_event, state) => setAbsolute(Number(state.value))}
            />
            <Select
              id="policy-destination"
              labelText="After session expiry"
              value={destination}
              onChange={(event) => setDestination(event.target.value as PostSessionDestination)}
            >
              <SelectItem value="login" text="Sign in" />
              <SelectItem value="visitor_terminal" text="Public visitor kiosk" />
            </Select>
            <Checkbox
              id="policy-default"
              labelText="Default for unregistered/private devices"
              checked={isDefault}
              onChange={(_, data) => setDefault(data.checked)}
            />
            {mutation.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Policy not saved"
                subtitle={mutation.error.message}
              />
            )}
          </Stack>
        </ModalBody>
        <ModalFooter>
          <Button kind="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={invalid}>
            {policy ? 'Save policy' : 'Create policy'}
          </Button>
        </ModalFooter>
      </Form>
    </ComposedModal>
  );
}

function duration(seconds: number) {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${Math.round(seconds / 60)}m`;
}
