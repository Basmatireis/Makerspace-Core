import {
  Button,
  Checkbox,
  FormGroup,
  InlineNotification,
  Modal,
  NumberInput,
  RadioButton,
  RadioButtonGroup,
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
  DeviceCapability,
  ManagedDevice,
  ManagedDeviceCredentialDelivery,
  ManagedDeviceProvisioning,
  ManagedDeviceType,
  SessionPolicy,
} from '../../../api/generated/models';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../../app/dateTime';
import {
  applyDeviceUse,
  assuranceLabels,
  capabilityLabels,
  configurationProblem,
  describeDeviceUse,
  deviceUseOf,
  deviceUseOptions,
  isKioskResetValid,
  kioskResetRange,
  kioskShowOptions,
  type DeviceConfiguration,
  type DeviceUse,
} from './deviceShared';
import { ExpirationFields } from './ExpirationModal';
import { MutationError } from './ConfirmationModal';

export function CreateDeviceModal({
  types,
  policies,
  onClose,
  onCreated,
}: {
  types: ManagedDeviceType[];
  policies: SessionPolicy[];
  onClose: () => void;
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
    allowTapCheckout: false,
    offerSurveysAtCheckout: false,
    kioskResetSeconds: 60,
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
  const invalid =
    !name.trim() ||
    !deviceTypeId ||
    configurationProblem(configuration) !== null ||
    (!noExpiration && !isZonedDateTimeValue(expiration)) ||
    pending;
  return (
    <Modal
      open
      size="md"
      hasScrollingContent
      aria-label="Create device"
      modalLabel="Managed devices"
      modalHeading="Create device"
      primaryButtonText="Create device"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={invalid}
      onRequestClose={onClose}
      onSecondarySubmit={onClose}
      onRequestSubmit={() => {
        if (!invalid) void submit();
      }}
    >
      <Stack gap={5}>
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
      </Stack>
    </Modal>
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
    allowTapCheckout: device.allowTapCheckout,
    offerSurveysAtCheckout: device.offerSurveysAtCheckout,
    kioskResetSeconds: device.kioskResetSeconds,
    capabilities: device.capabilities,
  });
  const invalid =
    !name.trim() ||
    configurationProblem(configuration) !== null ||
    (device.status !== 'expired' && !noExpiration && !isZonedDateTimeValue(expiration));
  return (
    <Modal
      open
      size="md"
      hasScrollingContent
      aria-label="Edit managed device"
      modalLabel="Managed devices"
      modalHeading="Edit managed device"
      primaryButtonText="Save"
      secondaryButtonText="Cancel"
      primaryButtonDisabled={pending || invalid}
      onRequestClose={onClose}
      onSecondarySubmit={onClose}
      onRequestSubmit={() =>
        onSubmit({
          name: name.trim(),
          deviceTypeId,
          expiresAt:
            device.status === 'expired' ? device.expiresAt : noExpiration ? null : zonedDateTimeValueToISO(expiration),
          ...configuration,
        })
      }
    >
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
    </Modal>
  );
}

function AssuranceSelect({
  id,
  labelText,
  value,
  onChange,
}: {
  id: string;
  labelText: string;
  value: AuthenticationAssurance;
  onChange: (value: AuthenticationAssurance) => void;
}) {
  const reachable = kioskShowOptions.some((option) => option.value === value);
  return (
    <Select
      id={id}
      labelText={labelText}
      value={value}
      onChange={(event) => onChange(event.target.value as AuthenticationAssurance)}
    >
      {!reachable && <SelectItem value={value} text={`${assuranceLabels[value]} (the kiosk cannot ask for this)`} />}
      {kioskShowOptions.map((option) => (
        <SelectItem key={option.value} value={option.value} text={option.label} />
      ))}
    </Select>
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
  const capabilityOptions: DeviceCapability[] = [
    'nfc',
    'camera',
    'qr',
    'barcode',
    'scale',
    'label_printer',
    'file_upload',
  ];
  const use = deviceUseOf(value);
  const help = deviceUseOptions.find((option) => option.value === use)?.help;
  const resetValid = isKioskResetValid(value.kioskResetSeconds);
  return (
    <Stack gap={5}>
      <RadioButtonGroup
        legendText="Used as"
        helperText={help ?? 'A combination this form does not offer. Choose one of the uses above to replace it.'}
        name={`${id}-used-as`}
        orientation="vertical"
        valueSelected={use === 'other' ? '' : use}
        onChange={(next) => onChange(applyDeviceUse(value, next as DeviceUse))}
      >
        {deviceUseOptions.map((option) => (
          <RadioButton
            key={option.value}
            id={`${id}-used-as-${option.value}`}
            labelText={option.label}
            value={option.value}
          />
        ))}
      </RadioButtonGroup>
      <Select
        id={`${id}-session-policy`}
        labelText="Session policy"
        invalid={value.terminalEnabled && !value.sessionPolicyId}
        invalidText="A kiosk needs an explicit session policy."
        value={value.sessionPolicyId ?? ''}
        onChange={(event) => onChange({ ...value, sessionPolicyId: event.target.value || null })}
      >
        <SelectItem value="" text="Default private-device policy" />
        {policies.map((policy) => (
          <SelectItem key={policy.id} value={policy.id} text={policy.name} />
        ))}
      </Select>
      {value.terminalEnabled && (
        <FormGroup legendText="Kiosk">
          <Stack gap={5}>
            <AssuranceSelect
              id={`${id}-check-in-assurance`}
              labelText="To check in, people show"
              value={value.checkInAssurance}
              onChange={(checkInAssurance) => onChange({ ...value, checkInAssurance })}
            />
            <AssuranceSelect
              id={`${id}-check-out-assurance`}
              labelText="To check out, people show"
              value={value.checkOutAssurance}
              onChange={(checkOutAssurance) => onChange({ ...value, checkOutAssurance })}
            />
            <Checkbox
              id={`${id}-allow-tap-checkout`}
              labelText="Also check out by tapping a name in the presence list"
              helperText="No sign-in. Handy when someone forgot, but anyone can tap anyone."
              checked={value.allowTapCheckout}
              onChange={(_, { checked }) => onChange({ ...value, allowTapCheckout: checked })}
            />
            <Checkbox
              id={`${id}-offer-surveys`}
              labelText="Offer surveys at check-out"
              helperText="Only after a check-out with what people show above, never after a tap in the list: then the tablet can't know who is standing in front of it. Which survey is offered is set on the survey."
              checked={value.offerSurveysAtCheckout}
              onChange={(_, { checked }) => onChange({ ...value, offerSurveysAtCheckout: checked })}
            />
            <NumberInput
              id={`${id}-kiosk-reset`}
              label="Back to the start screen after (seconds without a touch)"
              helperText="Also drops half-answered surveys and consent questions."
              min={kioskResetRange.min}
              max={kioskResetRange.max}
              allowEmpty
              value={Number.isNaN(value.kioskResetSeconds) ? '' : value.kioskResetSeconds}
              invalid={!resetValid}
              invalidText={`Enter ${kioskResetRange.min} to ${kioskResetRange.max} seconds.`}
              onChange={(_event, state) =>
                onChange({ ...value, kioskResetSeconds: state.value === '' ? Number.NaN : Number(state.value) })
              }
            />
          </Stack>
        </FormGroup>
      )}
      <FormGroup legendText="Device capabilities">
        <Stack gap={3}>
          {capabilityOptions.map((capability) => (
            <Checkbox
              key={capability}
              id={`${id}-capability-${capability}`}
              labelText={capabilityLabels[capability]}
              helperText={capability === 'file_upload' ? 'No hardware needed' : undefined}
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
      </FormGroup>
      <section className="device-summary" aria-labelledby={`${id}-summary-title`}>
        <p id={`${id}-summary-title`} className="cds--label">
          On this device
        </p>
        <ul>
          {describeDeviceUse(value).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      </section>
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
