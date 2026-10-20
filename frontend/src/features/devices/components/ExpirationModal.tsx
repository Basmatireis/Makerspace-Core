import {
  Button,
  Checkbox,
  ComposedModal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Stack,
} from '@carbon/react';
import { useState } from 'react';
import type { ManagedDevice, ManagedDeviceCredentialDelivery } from '../../../api/generated/models';
import { DateTimeInput } from '../../../app/DateInput';
import { instantToZonedDateTimeValue, isZonedDateTimeValue, zonedDateTimeValueToISO } from '../../../app/dateTime';
import { MutationError } from './ConfirmationModal';

export function ExpirationModal({
  device,
  pending,
  error,
  onClose,
  onSubmit,
}: {
  device: ManagedDevice;
  pending: boolean;
  error: Error | null;
  onClose: () => void;
  onSubmit: (expiresAt: string | null, credentialDelivery: ManagedDeviceCredentialDelivery) => void;
}) {
  const [noExpiration, setNoExpiration] = useState(device.expiresAt === null);
  const [expiration, setExpiration] = useState(device.expiresAt ? instantToZonedDateTimeValue(device.expiresAt) : '');
  const [credentialDelivery, setCredentialDelivery] = useState<ManagedDeviceCredentialDelivery>('nativeToken');
  return (
    <ComposedModal open onClose={onClose}>
      <ModalHeader title={`Rotate token for ${device.name}?`} />
      <ModalBody>
        <Stack gap={5}>
          <p>The current token stops working immediately. The replacement is shown only once.</p>
          {error && <MutationError title="Token not rotated" error={error} />}
          <ExpirationFields
            noExpiration={noExpiration}
            expiration={expiration}
            setNoExpiration={setNoExpiration}
            setExpiration={setExpiration}
            id="rotate"
          />
          <Select
            id="rotate-device-delivery"
            labelText="Credential delivery"
            value={credentialDelivery}
            onChange={(event) => setCredentialDelivery(event.target.value as ManagedDeviceCredentialDelivery)}
          >
            <SelectItem value="nativeToken" text="Native token (show once)" />
            <SelectItem value="bindBrowser" text="Bind this browser securely" />
          </Select>
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={pending || (!noExpiration && !isZonedDateTimeValue(expiration))}
          onClick={() => onSubmit(noExpiration ? null : zonedDateTimeValueToISO(expiration), credentialDelivery)}
        >
          Rotate token
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}

export function ExpirationFields({
  noExpiration,
  expiration,
  setNoExpiration,
  setExpiration,
  id,
}: {
  noExpiration: boolean;
  expiration: string;
  setNoExpiration: (value: boolean) => void;
  setExpiration: (value: string) => void;
  id: string;
}) {
  return (
    <>
      <Checkbox
        id={`${id}-no-expiration`}
        labelText="No expiration"
        checked={noExpiration}
        onChange={(_, data) => setNoExpiration(data.checked)}
      />
      {!noExpiration && (
        <DateTimeInput
          id={`${id}-expiration`}
          labelText="Expires at"
          required
          value={expiration}
          onChange={setExpiration}
        />
      )}
    </>
  );
}
