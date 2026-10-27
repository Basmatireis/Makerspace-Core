import {
  Button,
  Checkbox,
  ComposedModal,
  Form,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Stack,
  TextInput,
  Tile,
} from '@carbon/react';
import { Copy } from '@carbon/icons-react';
import { useState } from 'react';
import { createManagedDevice } from '../../../api/generated/managed-devices/managed-devices';
import type {
  AuthenticationAssurance,
  CheckoutMode,
  DeviceApplicationMode,
  DeviceCapability,
  ManagedDevice,
  ManagedDeviceCredentialDelivery,
  ManagedDeviceProvisioning,
  ManagedDeviceType,
  SessionPolicy,
} from '../../../api/generated/models';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../../app/dateTime';
import { DeviceConfiguration } from './deviceShared';
import { ExpirationFields } from './ExpirationModal';
import { MutationError } from './ConfirmationModal';

export function CreateDeviceForm({
  types,
  policies,
  onCreated,
}: {
  types: ManagedDeviceType[];
  policies: SessionPolicy[];
  onCreated: (value: ManagedDeviceProvisioning) => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [deviceTypeId, setDeviceTypeId] = useState('');
  const [noExpiration, setNoExpiration] = useState(true);
  const [expiration, setExpiration] = useState('');
  const [credentialDelivery, setCredentialDelivery] = useState<ManagedDeviceCredentialDelivery>('nativeToken');
  const [configuration, setConfiguration] = useState<DeviceConfiguration>({
    sessionPolicyId: null,
    terminalEnabled: false,
    allowedApplicationModes: ['staff_ui'],
    checkInAssurance: 'low',
    checkOutAssurance: 'low',
    checkoutMode: 'verified',
    capabilities: [],
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      const value = await createManagedDevice({
        name: name.trim(),
        deviceTypeId,
        expiresAt: noExpiration ? null : zonedDateTimeValueToISO(expiration),
        credentialDelivery,
        ...configuration,
      });
      setName('');
      setDeviceTypeId('');
      setNoExpiration(true);
      setExpiration('');
      await onCreated(value);
    } catch (caught) {
      setError(caught instanceof Error ? caught : new Error('Device creation failed'));
    } finally {
      setPending(false);
    }
  };
  return (
    <Tile className="form-tile">
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Stack gap={5}>
          <h2>Create device</h2>
          {error && <MutationError title="Device not created" error={error} />}
          <TextInput
            id="new-device-name"
            labelText="Device name"
            required
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Select
            id="new-device-type"
            labelText="Device type"
            required
            value={deviceTypeId}
            onChange={(event) => setDeviceTypeId(event.target.value)}
          >
            <SelectItem value="" text="Choose a type" />
            {types.map((type) => (
              <SelectItem key={type.id} value={type.id} text={type.name} />
            ))}
          </Select>
          <ExpirationFields
            noExpiration={noExpiration}
            expiration={expiration}
            setNoExpiration={setNoExpiration}
            setExpiration={setExpiration}
            id="create"
          />
          <DevicePolicyFields id="create" policies={policies} value={configuration} onChange={setConfiguration} />
          <Select
            id="new-device-delivery"
            labelText="Credential delivery"
            value={credentialDelivery}
            onChange={(event) => setCredentialDelivery(event.target.value as ManagedDeviceCredentialDelivery)}
          >
            <SelectItem value="nativeToken" text="Native token (show once)" />
            <SelectItem value="bindBrowser" text="Bind this browser securely" />
          </Select>
          <Button
            type="submit"
            disabled={
              !name.trim() ||
              !deviceTypeId ||
              configuration.allowedApplicationModes.length === 0 ||
              (configuration.terminalEnabled &&
                (!configuration.sessionPolicyId ||
                  !configuration.allowedApplicationModes.includes('visitor_terminal'))) ||
              (!noExpiration && !isZonedDateTimeValue(expiration)) ||
              pending
            }
          >
            Create device
          </Button>
        </Stack>
      </Form>
    </Tile>
  );
}

export function DeviceFormModal({
  device,
  types,
  policies,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  device: ManagedDevice;
  types: ManagedDeviceType[];
  policies: SessionPolicy[];
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (value: { name: string; deviceTypeId: string; expiresAt: string | null } & DeviceConfiguration) => void;
}) {
  const [name, setName] = useState(device.name);
  const [deviceTypeId, setDeviceTypeId] = useState(device.deviceTypeId);
  const [noExpiration, setNoExpiration] = useState(device.expiresAt === null);
  const [expiration, setExpiration] = useState(device.expiresAt ? instantToZonedDateTimeValue(device.expiresAt) : '');
  const [configuration, setConfiguration] = useState<DeviceConfiguration>({
    sessionPolicyId: device.sessionPolicyId,
    terminalEnabled: device.terminalEnabled,
    allowedApplicationModes: device.allowedApplicationModes,
    checkInAssurance: device.checkInAssurance,
    checkOutAssurance: device.checkOutAssurance,
    checkoutMode: device.checkoutMode,
    capabilities: device.capabilities,
  });
  return (
    <ComposedModal open onClose={onClose}>
      <ModalHeader title="Edit managed device" />
      <ModalBody>
        <Stack gap={5}>
          {error && <MutationError title="Device not updated" error={error} />}
          <TextInput
            id="edit-device-name"
            labelText="Device name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <Select
            id="edit-device-type"
            labelText="Device type"
            value={deviceTypeId}
            onChange={(event) => setDeviceTypeId(event.target.value)}
          >
            {types.map((type) => (
              <SelectItem key={type.id} value={type.id} text={type.name} />
            ))}
          </Select>
          {device.status === 'expired' ? (
            <InlineNotification
              kind="info"
              lowContrast
              hideCloseButton
              title="Token expired"
              subtitle="Rotate the token to choose a new expiration. Name and type can still be edited."
            />
          ) : (
            <ExpirationFields
              noExpiration={noExpiration}
              expiration={expiration}
              setNoExpiration={setNoExpiration}
              setExpiration={setExpiration}
              id="edit"
            />
          )}
          <DevicePolicyFields id="edit" policies={policies} value={configuration} onChange={setConfiguration} />
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={
            pending ||
            !name.trim() ||
            configuration.allowedApplicationModes.length === 0 ||
            (configuration.terminalEnabled &&
              (!configuration.sessionPolicyId ||
                !configuration.allowedApplicationModes.includes('visitor_terminal'))) ||
            (device.status !== 'expired' && !noExpiration && !isZonedDateTimeValue(expiration))
          }
          onClick={() =>
            onSubmit({
              name: name.trim(),
              deviceTypeId,
              expiresAt:
                device.status === 'expired'
                  ? device.expiresAt
                  : noExpiration
                    ? null
                    : zonedDateTimeValueToISO(expiration),
              ...configuration,
            })
          }
        >
          Save
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}

function DevicePolicyFields({
  id,
  policies,
  value,
  onChange,
}: {
  id: string;
  policies: SessionPolicy[];
  value: DeviceConfiguration;
  onChange: (value: DeviceConfiguration) => void;
}) {
  const capabilityOptions: DeviceCapability[] = ['nfc', 'camera', 'qr', 'barcode', 'scale', 'label_printer'];
  const applicationModes: DeviceApplicationMode[] = ['visitor_terminal', 'staff_ui'];
  return (
    <Stack gap={4}>
      <Select
        id={`${id}-session-policy`}
        labelText="Session policy"
        invalid={value.terminalEnabled && !value.sessionPolicyId}
        invalidText="Public kiosks require an explicit session policy."
        value={value.sessionPolicyId ?? ''}
        onChange={(event) => onChange({ ...value, sessionPolicyId: event.target.value || null })}
      >
        <SelectItem value="" text="Default private-device policy" />
        {policies.map((policy) => (
          <SelectItem key={policy.id} value={policy.id} text={policy.name} />
        ))}
      </Select>
      <fieldset>
        <legend>Allowed application modes</legend>
        <Stack gap={2}>
          {applicationModes.map((mode) => (
            <Checkbox
              key={mode}
              id={`${id}-mode-${mode}`}
              labelText={mode === 'visitor_terminal' ? 'Visitor kiosk' : 'Staff UI'}
              checked={value.allowedApplicationModes.includes(mode)}
              onChange={(_, data) =>
                onChange({
                  ...value,
                  allowedApplicationModes: data.checked
                    ? [...value.allowedApplicationModes, mode]
                    : value.allowedApplicationModes.filter((item) => item !== mode),
                })
              }
            />
          ))}
        </Stack>
      </fieldset>
      <Checkbox
        id={`${id}-kiosk-enabled`}
        labelText="Enable public visitor kiosk"
        checked={value.terminalEnabled}
        onChange={(_, data) =>
          onChange({
            ...value,
            terminalEnabled: data.checked,
            allowedApplicationModes:
              data.checked && !value.allowedApplicationModes.includes('visitor_terminal')
                ? [...value.allowedApplicationModes, 'visitor_terminal']
                : value.allowedApplicationModes,
          })
        }
      />
      {value.terminalEnabled && (
        <>
          <Select
            id={`${id}-check-in-assurance`}
            labelText="Check-in assurance"
            value={value.checkInAssurance}
            onChange={(event) =>
              onChange({ ...value, checkInAssurance: event.target.value as AuthenticationAssurance })
            }
          >
            {['low', 'normal', 'strong', 'strong_mfa'].map((item) => (
              <SelectItem key={item} value={item} text={item} />
            ))}
          </Select>
          <Select
            id={`${id}-check-out-assurance`}
            labelText="Checkout assurance"
            value={value.checkOutAssurance}
            onChange={(event) =>
              onChange({ ...value, checkOutAssurance: event.target.value as AuthenticationAssurance })
            }
          >
            {['low', 'normal', 'strong', 'strong_mfa'].map((item) => (
              <SelectItem key={item} value={item} text={item} />
            ))}
          </Select>
          <Select
            id={`${id}-checkout-mode`}
            labelText="Checkout mode"
            value={value.checkoutMode}
            onChange={(event) => onChange({ ...value, checkoutMode: event.target.value as CheckoutMode })}
          >
            <SelectItem value="verified" text="Verified credential" />
            <SelectItem value="public_tap" text="Public tap from Currently Here" />
          </Select>
          <fieldset>
            <legend>Device capabilities</legend>
            <Stack gap={2}>
              {capabilityOptions.map((capability) => (
                <Checkbox
                  key={capability}
                  id={`${id}-capability-${capability}`}
                  labelText={capability.replace('_', ' ')}
                  checked={value.capabilities.includes(capability)}
                  onChange={(_, data) =>
                    onChange({
                      ...value,
                      capabilities: data.checked
                        ? [...value.capabilities, capability]
                        : value.capabilities.filter((item) => item !== capability),
                    })
                  }
                />
              ))}
            </Stack>
          </fieldset>
        </>
      )}
    </Stack>
  );
}

export function OneTimeToken({
  provisioning,
  onDismiss,
}: {
  provisioning: ManagedDeviceProvisioning;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Tile className="secret-tile">
      <Stack gap={4}>
        {provisioning.token ? (
          <>
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title="Copy this device token now"
              subtitle="It is shown only once and cannot be retrieved later."
            />
            <TextInput
              id="device-token"
              labelText={`One-time token for ${provisioning.device.name}`}
              readOnly
              value={provisioning.token}
            />
            <div className="form-actions">
              <Button
                kind="secondary"
                renderIcon={Copy}
                onClick={async () => {
                  await navigator.clipboard.writeText(provisioning.token!);
                  setCopied(true);
                }}
              >
                {copied ? 'Copied' : 'Copy token'}
              </Button>
              <Button kind="ghost" onClick={onDismiss}>
                Dismiss permanently
              </Button>
            </div>
          </>
        ) : (
          <>
            <InlineNotification
              kind="success"
              lowContrast
              hideCloseButton
              title="Browser bound"
              subtitle="The managed-device credential is stored in a secure HttpOnly cookie and is unavailable to JavaScript."
            />
            <Button kind="ghost" onClick={onDismiss}>
              Dismiss
            </Button>
          </>
        )}
      </Stack>
    </Tile>
  );
}
