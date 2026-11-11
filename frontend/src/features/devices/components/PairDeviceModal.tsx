import { Modal, Select, SelectItem, Stack, TextInput } from '@carbon/react';
import { useState } from 'react';
import { pairManagedDevice } from '../../../api/generated/managed-devices/managed-devices';
import type { ManagedDevice, ManagedDeviceType, SessionPolicy } from '../../../api/generated/models';
import { ApiError, apiErrorCode } from '../../../api/http-client';
import { isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../../app/dateTime';
import { MutationError } from './ConfirmationModal';
import { DevicePolicyFields } from './DeviceFormModal';
import { configurationProblem, type DeviceConfiguration } from './deviceShared';
import { ExpirationFields } from './ExpirationModal';

/** Characters a kiosk's pairing codes are made of (no I, O, 0 or 1). */
const CODE_PATTERN = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const normalizePairingCode = (value: string) => value.replace(/[\s-]+/g, '').toUpperCase();
const CODE_REJECTED =
  'This code was not accepted. Check the code on the kiosk; codes expire after 15 minutes. After several wrong attempts, wait a few minutes.';

/**
 * Registers a kiosk by the code it shows: the same settings as creating a device, but the credential goes straight
 * to the kiosk (browser cookie or desktop app) instead of being shown here. Unknown, expired and rate-limited codes
 * all read the same.
 */
export function PairDeviceModal({
  types,
  policies,
  onClose,
  onPaired,
}: {
  types: ManagedDeviceType[];
  policies: SessionPolicy[];
  onClose: () => void;
  onPaired: (device: ManagedDevice) => Promise<void>;
}) {
  const [code, setCode] = useState('');
  const [codeTouched, setCodeTouched] = useState(false);
  const [codeRejected, setCodeRejected] = useState(false);
  const [name, setName] = useState('');
  const [deviceTypeId, setDeviceTypeId] = useState('');
  const [noExpiration, setNoExpiration] = useState(true);
  const [expiration, setExpiration] = useState('');
  const [configuration, setConfiguration] = useState<DeviceConfiguration>({
    sessionPolicyId: null,
    terminalEnabled: true,
    allowedApplicationModes: ['visitor_terminal'],
    checkInMethods: ['email_code', 'password'],
    checkOutMethods: ['email_code', 'password'],
    allowTapCheckout: false,
    offerSurveysAtCheckout: false,
    kioskResetSeconds: 60,
    capabilities: [],
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const codeValid = CODE_PATTERN.test(normalizePairingCode(code));
  const submit = async () => {
    setPending(true);
    setError(null);
    setCodeRejected(false);
    try {
      const device = await pairManagedDevice({
        code: normalizePairingCode(code),
        name: name.trim(),
        deviceTypeId,
        expiresAt: noExpiration ? null : zonedDateTimeValueToISO(expiration),
        ...configuration,
      });
      await onPaired(device);
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        ((caught.status === 422 && apiErrorCode(caught) === 'pairing_code_invalid') || caught.status === 429)
      ) {
        setCodeRejected(true);
      } else {
        setError(caught instanceof Error ? caught : new Error('Pairing failed'));
      }
    } finally {
      setPending(false);
    }
  };
  const invalid =
    !codeValid ||
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
      aria-label="Pair device"
      modalLabel="Managed devices"
      modalHeading="Pair device"
      primaryButtonText={pending ? 'Pairing…' : 'Pair device'}
      secondaryButtonText="Cancel"
      primaryButtonDisabled={invalid}
      preventCloseOnClickOutside
      onRequestClose={() => {
        if (!pending) onClose();
      }}
      onSecondarySubmit={onClose}
      onRequestSubmit={() => {
        if (!invalid) void submit();
      }}
    >
      <Stack gap={5}>
        <p>
          Open <strong>/kiosk</strong> in the kiosk&apos;s browser, or start the Makerspace Core desktop app and enter
          this server&apos;s address. The kiosk then shows a 6-character code.
        </p>
        {error && <MutationError title="Device not paired" error={error} />}
        <TextInput
          id="pair-device-code"
          labelText="Pairing code"
          placeholder="e.g. K7F2QX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          helperText="Letters A–Z (without I and O) and digits 2–9; case does not matter."
          value={code}
          invalid={codeRejected || (codeTouched && code !== '' && !codeValid)}
          invalidText={codeRejected ? CODE_REJECTED : 'Enter the 6 characters shown on the kiosk'}
          onBlur={() => setCodeTouched(true)}
          onChange={(event) => {
            setCode(event.target.value);
            setCodeRejected(false);
          }}
        />
        <TextInput
          id="pair-device-name"
          labelText="Device name"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <Select
          id="pair-device-type"
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
          id="pair"
        />
        <DevicePolicyFields id="pair" policies={policies} value={configuration} onChange={setConfiguration} />
      </Stack>
    </Modal>
  );
}
