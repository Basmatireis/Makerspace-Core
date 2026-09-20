import {
  Button, Checkbox, ComposedModal, DataTable, Form, InlineNotification,
  ModalBody, ModalFooter, ModalHeader, OverflowMenu, OverflowMenuItem,
  Select, SelectItem, Stack, Table, TableBody, TableCell, TableContainer,
  TableHead, TableHeader, TableRow, Tag, TextArea, TextInput, Tile,
} from '@carbon/react';
import { Copy } from '@carbon/icons-react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  createManagedDevice, createManagedDeviceType, deleteManagedDevice,
  deleteManagedDeviceType, listManagedDevices, listManagedDeviceTypes,
  revokeManagedDevice, rotateManagedDeviceToken, updateManagedDevice,
  updateManagedDeviceType,
} from '../../api/generated/managed-devices/managed-devices';
import type { ManagedDevice, ManagedDeviceCredentialDelivery, ManagedDeviceProvisioning, ManagedDeviceType } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { PageHeader } from '../../app/PageHeader';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';

const keys = {
  devices: ['managed-devices'] as const,
  types: ['managed-device-types'] as const,
};

type Confirmation = { kind: 'revoke' | 'delete'; device: ManagedDevice } | null;

export function ManagedDevicesPage() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const canManage = hasPermission(currentUser, PermissionId.managed_devicesmanage);
  const devicesQuery = useInfiniteQuery({
    queryKey: keys.devices,
    queryFn: ({ signal, pageParam }) => listManagedDevices({ limit: 50, cursor: pageParam }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const typesQuery = useQuery({
    queryKey: keys.types,
    queryFn: ({ signal }) => listManagedDeviceTypes({ signal }),
  });
  const [secret, setSecret] = useState<ManagedDeviceProvisioning | null>(null);
  const [editingDevice, setEditingDevice] = useState<ManagedDevice | null>(null);
  const [rotatingDevice, setRotatingDevice] = useState<ManagedDevice | null>(null);
  const [editingType, setEditingType] = useState<ManagedDeviceType | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);
  const [rotatePending, setRotatePending] = useState(false);
  const [rotateError, setRotateError] = useState<Error | null>(null);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.devices }),
      queryClient.invalidateQueries({ queryKey: keys.types }),
    ]);
  };

  const editDeviceMutation = useMutation({
    mutationFn: ({ device, name, deviceTypeId, expiresAt }: {
      device: ManagedDevice; name: string; deviceTypeId: string; expiresAt: string | null;
    }) => updateManagedDevice(device.id, {
      name, deviceTypeId, expiresAt, expectedVersion: device.version,
    }),
    onSuccess: async () => { setEditingDevice(null); await refresh(); },
  });
  const rotate = async (device: ManagedDevice, expiresAt: string | null, credentialDelivery: ManagedDeviceCredentialDelivery) => {
    setRotatePending(true);
    setRotateError(null);
    try {
      const provisioning = await rotateManagedDeviceToken(device.id, {
        expiresAt,
        expectedVersion: device.version,
        credentialDelivery,
      });
      setRotatingDevice(null);
      setSecret(provisioning);
      await refresh();
    } catch (error) {
      setRotateError(error instanceof Error ? error : new Error('Token rotation failed'));
    } finally {
      setRotatePending(false);
    }
  };
  const lifecycleMutation = useMutation({
    mutationFn: async (value: NonNullable<Confirmation>) => {
      if (value.kind === 'revoke') {
        await revokeManagedDevice(value.device.id, { expectedVersion: value.device.version });
      } else {
        await deleteManagedDevice(value.device.id, { expectedVersion: value.device.version });
      }
    },
    onSuccess: async () => { setConfirmation(null); await refresh(); },
  });
  const editTypeMutation = useMutation({
    mutationFn: ({ type, name, description }: {
      type: ManagedDeviceType; name: string; description: string | null;
    }) => updateManagedDeviceType(type.id, {
      name, description, expectedVersion: type.version,
    }),
    onSuccess: async () => { setEditingType(null); await refresh(); },
  });
  const deleteTypeMutation = useMutation({
    mutationFn: (type: ManagedDeviceType) =>
      deleteManagedDeviceType(type.id, { expectedVersion: type.version }),
    onSuccess: refresh,
  });

  return (
    <Stack gap={7}>
      <PageHeader
        title="Managed devices"
        breadcrumbs={[{ label: 'Settings', to: '/settings' }]}
        description="Register trusted local computers and control device-scoped access."
      />
      {secret && <OneTimeToken provisioning={secret} onDismiss={() => setSecret(null)} />}
      {devicesQuery.isPending && <InlineLoadingState label="Loading managed devices" />}
      {devicesQuery.isError && (
        <ErrorState title="Unable to load managed devices" message="Check the connection and try again." onRetry={() => void devicesQuery.refetch()} />
      )}
      {devicesQuery.data && (
        <Stack gap={4}>
          <DeviceTable
            devices={devicesQuery.data.pages.flatMap((page) => page.items)}
            canManage={canManage}
            onEdit={setEditingDevice}
            onRotate={setRotatingDevice}
            onConfirm={(kind, device) => setConfirmation({ kind, device })}
          />
          {devicesQuery.hasNextPage && <Button kind="tertiary" disabled={devicesQuery.isFetchingNextPage} onClick={() => void devicesQuery.fetchNextPage()}>Load more devices</Button>}
        </Stack>
      )}
      {canManage && typesQuery.data && (
        <CreateDeviceForm types={typesQuery.data.items} onCreated={async (value) => { setSecret(value); await refresh(); }} />
      )}
      <DeviceTypesPanel
        types={typesQuery.data?.items ?? []}
        loading={typesQuery.isPending}
        canManage={canManage}
        deleteError={deleteTypeMutation.error}
        onEdit={setEditingType}
        onDelete={(type) => deleteTypeMutation.mutate(type)}
        onCreated={refresh}
      />
      {editingDevice && typesQuery.data && (
        <DeviceFormModal
          device={editingDevice}
          types={typesQuery.data.items}
          pending={editDeviceMutation.isPending}
          error={editDeviceMutation.error}
          onClose={() => setEditingDevice(null)}
          onSubmit={(values) => editDeviceMutation.mutate({ device: editingDevice, ...values })}
        />
      )}
      {rotatingDevice && (
        <ExpirationModal
          device={rotatingDevice}
          pending={rotatePending}
          error={rotateError}
          onClose={() => { setRotatingDevice(null); setRotateError(null); }}
          onSubmit={(expiresAt, credentialDelivery) => void rotate(rotatingDevice, expiresAt, credentialDelivery)}
        />
      )}
      {editingType && (
        <DeviceTypeModal
          type={editingType}
          pending={editTypeMutation.isPending}
          error={editTypeMutation.error}
          onClose={() => setEditingType(null)}
          onSubmit={(values) => editTypeMutation.mutate({ type: editingType, ...values })}
        />
      )}
      <ConfirmationModal
        value={confirmation}
        pending={lifecycleMutation.isPending}
        error={lifecycleMutation.error}
        onClose={() => setConfirmation(null)}
        onConfirm={() => confirmation && lifecycleMutation.mutate(confirmation)}
      />
    </Stack>
  );
}

function DeviceTable({ devices, canManage, onEdit, onRotate, onConfirm }: {
  devices: ManagedDevice[];
  canManage: boolean;
  onEdit: (device: ManagedDevice) => void;
  onRotate: (device: ManagedDevice) => void;
  onConfirm: (kind: 'revoke' | 'delete', device: ManagedDevice) => void;
}) {
  const headers = [
    { key: 'name', header: 'Device name' }, { key: 'type', header: 'Device type' },
    { key: 'status', header: 'Status' }, { key: 'lastSeen', header: 'Last seen' },
    { key: 'expires', header: 'Token expiration' }, { key: 'actions', header: '' },
  ];
  const rows = devices.map((device) => ({
    id: device.id,
    name: device.name,
    type: device.deviceTypeName,
    status: device.status,
    lastSeen: formatDate(device.lastSeenAt, 'Never'),
    expires: formatDate(device.expiresAt, 'No expiration'),
    actions: device,
  }));
  return (
    <DataTable rows={rows} headers={headers}>
      {({ rows: tableRows, headers: tableHeaders, getHeaderProps, getRowProps, getTableProps }) => (
        <TableContainer title="Registered devices"><Table {...getTableProps()}>
          <TableHead><TableRow>{tableHeaders.map((header) => (
            <TableHeader {...getHeaderProps({ header })} key={header.key}>{header.header}</TableHeader>
          ))}</TableRow></TableHead>
          <TableBody>{tableRows.map((row) => (
            <TableRow {...getRowProps({ row })} key={row.id}>{row.cells.map((cell) => (
              <TableCell key={cell.id}>
                {cell.info.header === 'status' ? <StatusTag status={String(cell.value)} /> :
                  cell.info.header === 'actions' && canManage ? (
                    <DeviceMenu device={cell.value as ManagedDevice} onEdit={onEdit} onRotate={onRotate} onConfirm={onConfirm} />
                  ) : String(cell.value)}
              </TableCell>
            ))}</TableRow>
          ))}</TableBody>
        </Table></TableContainer>
      )}
    </DataTable>
  );
}

function DeviceMenu({ device, onEdit, onRotate, onConfirm }: {
  device: ManagedDevice;
  onEdit: (device: ManagedDevice) => void;
  onRotate: (device: ManagedDevice) => void;
  onConfirm: (kind: 'revoke' | 'delete', device: ManagedDevice) => void;
}) {
  return (
    <OverflowMenu aria-label={`Actions for ${device.name}`} flipped>
      <OverflowMenuItem itemText="Edit" onClick={() => onEdit(device)} />
      {device.status !== 'revoked' && <OverflowMenuItem itemText="Rotate token" onClick={() => onRotate(device)} />}
      {device.status !== 'revoked' ? (
        <OverflowMenuItem isDelete itemText="Revoke" onClick={() => onConfirm('revoke', device)} />
      ) : (
        <OverflowMenuItem isDelete itemText="Delete" onClick={() => onConfirm('delete', device)} />
      )}
    </OverflowMenu>
  );
}

function StatusTag({ status }: { status: string }) {
  const type = status === 'active' ? 'green' : status === 'expired' ? 'warm-gray' : 'red';
  return <Tag type={type}>{status[0].toUpperCase() + status.slice(1)}</Tag>;
}

function CreateDeviceForm({ types, onCreated }: {
  types: ManagedDeviceType[];
  onCreated: (value: ManagedDeviceProvisioning) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [deviceTypeId, setDeviceTypeId] = useState('');
  const [noExpiration, setNoExpiration] = useState(true);
  const [expiration, setExpiration] = useState('');
  const [credentialDelivery, setCredentialDelivery] = useState<ManagedDeviceCredentialDelivery>('nativeToken');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const value = await createManagedDevice({
        name: name.trim(), deviceTypeId,
        expiresAt: noExpiration ? null : localDateTimeToISO(expiration),
        credentialDelivery,
      });
      setName(''); setDeviceTypeId(''); setNoExpiration(true); setExpiration('');
      await onCreated(value);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Device creation failed'));
    } finally {
      setPending(false);
    }
  };
  return (
    <Tile className="form-tile"><Form onSubmit={(event) => { event.preventDefault(); void submit(); }}><Stack gap={5}>
      <h2>Create device</h2>
      {error && <MutationError title="Device not created" error={error} />}
      <TextInput id="new-device-name" labelText="Device name" required value={name} onChange={(event) => setName(event.target.value)} />
      <Select id="new-device-type" labelText="Device type" required value={deviceTypeId} onChange={(event) => setDeviceTypeId(event.target.value)}>
        <SelectItem value="" text="Choose a type" />
        {types.map((type) => <SelectItem key={type.id} value={type.id} text={type.name} />)}
      </Select>
      <ExpirationFields noExpiration={noExpiration} expiration={expiration} setNoExpiration={setNoExpiration} setExpiration={setExpiration} id="create" />
      <Select id="new-device-delivery" labelText="Credential delivery" value={credentialDelivery} onChange={(event) => setCredentialDelivery(event.target.value as ManagedDeviceCredentialDelivery)}>
        <SelectItem value="nativeToken" text="Native token (show once)" />
        <SelectItem value="bindBrowser" text="Bind this browser securely" />
      </Select>
      <Button type="submit" disabled={!name.trim() || !deviceTypeId || (!noExpiration && !expiration) || pending}>Create device</Button>
    </Stack></Form></Tile>
  );
}

function DeviceFormModal({ device, types, pending, error, onClose, onSubmit }: {
  device: ManagedDevice; types: ManagedDeviceType[]; pending: boolean; error: Error | null;
  onClose: () => void;
  onSubmit: (value: { name: string; deviceTypeId: string; expiresAt: string | null }) => void;
}) {
  const [name, setName] = useState(device.name);
  const [deviceTypeId, setDeviceTypeId] = useState(device.deviceTypeId);
  const [noExpiration, setNoExpiration] = useState(device.expiresAt === null);
  const [expiration, setExpiration] = useState(toLocalDateTime(device.expiresAt));
  return (
    <ComposedModal open onClose={onClose}>
      <ModalHeader title="Edit managed device" />
      <ModalBody><Stack gap={5}>
        {error && <MutationError title="Device not updated" error={error} />}
        <TextInput id="edit-device-name" labelText="Device name" value={name} onChange={(event) => setName(event.target.value)} />
        <Select id="edit-device-type" labelText="Device type" value={deviceTypeId} onChange={(event) => setDeviceTypeId(event.target.value)}>
          {types.map((type) => <SelectItem key={type.id} value={type.id} text={type.name} />)}
        </Select>
        {device.status === 'expired' ? (
          <InlineNotification kind="info" lowContrast hideCloseButton title="Token expired" subtitle="Rotate the token to choose a new expiration. Name and type can still be edited." />
        ) : (
          <ExpirationFields noExpiration={noExpiration} expiration={expiration} setNoExpiration={setNoExpiration} setExpiration={setExpiration} id="edit" />
        )}
      </Stack></ModalBody>
      <ModalFooter><Button kind="secondary" onClick={onClose}>Cancel</Button><Button disabled={pending || !name.trim() || (device.status !== 'expired' && !noExpiration && !expiration)} onClick={() => onSubmit({ name: name.trim(), deviceTypeId, expiresAt: device.status === 'expired' ? device.expiresAt : noExpiration ? null : localDateTimeToISO(expiration) })}>Save</Button></ModalFooter>
    </ComposedModal>
  );
}

function ExpirationModal({ device, pending, error, onClose, onSubmit }: {
  device: ManagedDevice; pending: boolean; error: Error | null; onClose: () => void;
  onSubmit: (expiresAt: string | null, credentialDelivery: ManagedDeviceCredentialDelivery) => void;
}) {
  const [noExpiration, setNoExpiration] = useState(device.expiresAt === null);
  const [expiration, setExpiration] = useState(toLocalDateTime(device.expiresAt));
  const [credentialDelivery, setCredentialDelivery] = useState<ManagedDeviceCredentialDelivery>('nativeToken');
  return (
    <ComposedModal open onClose={onClose}>
      <ModalHeader title={`Rotate token for ${device.name}?`} />
      <ModalBody><Stack gap={5}>
        <p>The current token stops working immediately. The replacement is shown only once.</p>
        {error && <MutationError title="Token not rotated" error={error} />}
        <ExpirationFields noExpiration={noExpiration} expiration={expiration} setNoExpiration={setNoExpiration} setExpiration={setExpiration} id="rotate" />
        <Select id="rotate-device-delivery" labelText="Credential delivery" value={credentialDelivery} onChange={(event) => setCredentialDelivery(event.target.value as ManagedDeviceCredentialDelivery)}>
          <SelectItem value="nativeToken" text="Native token (show once)" />
          <SelectItem value="bindBrowser" text="Bind this browser securely" />
        </Select>
      </Stack></ModalBody>
      <ModalFooter><Button kind="secondary" onClick={onClose}>Cancel</Button><Button disabled={pending || (!noExpiration && !expiration)} onClick={() => onSubmit(noExpiration ? null : localDateTimeToISO(expiration), credentialDelivery)}>Rotate token</Button></ModalFooter>
    </ComposedModal>
  );
}

function ExpirationFields({ noExpiration, expiration, setNoExpiration, setExpiration, id }: {
  noExpiration: boolean; expiration: string; setNoExpiration: (value: boolean) => void;
  setExpiration: (value: string) => void; id: string;
}) {
  return <>
    <Checkbox id={`${id}-no-expiration`} labelText="No expiration" checked={noExpiration} onChange={(_, data) => setNoExpiration(data.checked)} />
    {!noExpiration && <TextInput id={`${id}-expiration`} type="datetime-local" labelText="Expires at" required value={expiration} onChange={(event) => setExpiration(event.target.value)} />}
  </>;
}

function OneTimeToken({ provisioning, onDismiss }: { provisioning: ManagedDeviceProvisioning; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <Tile className="secret-tile"><Stack gap={4}>
      {provisioning.token ? <>
        <InlineNotification kind="warning" lowContrast hideCloseButton title="Copy this device token now" subtitle="It is shown only once and cannot be retrieved later." />
        <TextInput id="device-token" labelText={`One-time token for ${provisioning.device.name}`} readOnly value={provisioning.token} />
        <div className="form-actions"><Button kind="secondary" renderIcon={Copy} onClick={async () => { await navigator.clipboard.writeText(provisioning.token!); setCopied(true); }}>{copied ? 'Copied' : 'Copy token'}</Button><Button kind="ghost" onClick={onDismiss}>Dismiss permanently</Button></div>
      </> : <>
        <InlineNotification kind="success" lowContrast hideCloseButton title="Browser bound" subtitle="The managed-device credential is stored in a secure HttpOnly cookie and is unavailable to JavaScript." />
        <Button kind="ghost" onClick={onDismiss}>Dismiss</Button>
      </>}
    </Stack></Tile>
  );
}

function DeviceTypesPanel({ types, loading, canManage, deleteError, onEdit, onDelete, onCreated }: {
  types: ManagedDeviceType[]; loading: boolean; canManage: boolean; deleteError: Error | null;
  onEdit: (type: ManagedDeviceType) => void; onDelete: (type: ManagedDeviceType) => void;
  onCreated: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const createMutation = useMutation({
    mutationFn: () => createManagedDeviceType({ name: name.trim(), description: description.trim() || null }),
    onSuccess: async () => { setName(''); setDescription(''); await onCreated(); },
  });
  return (
    <Tile><Stack gap={5}>
      <h2>Device types</h2>
      {loading && <InlineLoadingState label="Loading device types" />}
      {deleteError && <MutationError title="Device type not deleted" error={deleteError} conflictMessage="This type is still used by a device or role permission." />}
      {types.map((type) => <div className="section-heading" key={type.id}>
        <div><strong>{type.name}</strong><p className="section-description">{type.description || 'No description'}</p></div>
        {canManage && <div className="button-cluster"><Button kind="ghost" size="sm" onClick={() => onEdit(type)}>Edit</Button><Button kind="danger--ghost" size="sm" onClick={() => onDelete(type)}>Delete</Button></div>}
      </div>)}
      {canManage && <Form onSubmit={(event) => { event.preventDefault(); createMutation.mutate(); }}><Stack gap={4}>
        {createMutation.isError && <MutationError title="Device type not created" error={createMutation.error} />}
        <TextInput id="new-type-name" labelText="Type name" required value={name} onChange={(event) => setName(event.target.value)} />
        <TextArea id="new-type-description" labelText="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
        <Button type="submit" disabled={!name.trim() || createMutation.isPending}>Create device type</Button>
      </Stack></Form>}
    </Stack></Tile>
  );
}

function DeviceTypeModal({ type, pending, error, onClose, onSubmit }: {
  type: ManagedDeviceType; pending: boolean; error: Error | null; onClose: () => void;
  onSubmit: (value: { name: string; description: string | null }) => void;
}) {
  const [name, setName] = useState(type.name);
  const [description, setDescription] = useState(type.description ?? '');
  return (
    <ComposedModal open onClose={onClose}>
      <ModalHeader title="Edit device type" />
      <ModalBody><Stack gap={5}>
        {error && <MutationError title="Device type not updated" error={error} />}
        <TextInput id="edit-type-name" labelText="Type name" value={name} onChange={(event) => setName(event.target.value)} />
        <TextArea id="edit-type-description" labelText="Description" value={description} onChange={(event) => setDescription(event.target.value)} />
      </Stack></ModalBody>
      <ModalFooter><Button kind="secondary" onClick={onClose}>Cancel</Button><Button disabled={pending || !name.trim()} onClick={() => onSubmit({ name: name.trim(), description: description.trim() || null })}>Save</Button></ModalFooter>
    </ComposedModal>
  );
}

function ConfirmationModal({ value, pending, error, onClose, onConfirm }: {
  value: Confirmation; pending: boolean; error: Error | null; onClose: () => void; onConfirm: () => void;
}) {
  const revoke = value?.kind === 'revoke';
  return (
    <ComposedModal open={Boolean(value)} danger onClose={onClose}>
      <ModalHeader title={revoke ? `Revoke ${value?.device.name}?` : `Delete ${value?.device.name}?`} />
      <ModalBody><Stack gap={4}>
        <p>{revoke ? 'Its token and all device-scoped privileges stop working immediately. Revocation cannot be reversed.' : 'The revoked device record will be permanently deleted. Audit history is retained.'}</p>
        {error && <MutationError title={revoke ? 'Device not revoked' : 'Device not deleted'} error={error} />}
      </Stack></ModalBody>
      <ModalFooter><Button kind="secondary" onClick={onClose}>Cancel</Button><Button kind="danger" disabled={pending} onClick={onConfirm}>{revoke ? 'Revoke device' : 'Delete device'}</Button></ModalFooter>
    </ComposedModal>
  );
}

function MutationError({ title, error, conflictMessage }: { title: string; error: Error; conflictMessage?: string }) {
  const message = conflictMessage && error instanceof ApiError && error.status === 409 ? conflictMessage : error.message;
  return <InlineNotification kind="error" lowContrast hideCloseButton title={title} subtitle={message} />;
}

function formatDate(value: string | null, fallback: string) {
  return value ? new Date(value).toLocaleString() : fallback;
}

function toLocalDateTime(value: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function localDateTimeToISO(value: string) {
  return new Date(value).toISOString();
}
