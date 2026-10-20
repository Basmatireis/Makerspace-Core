import type {
  AuthenticationAssurance,
  CheckoutMode,
  DeviceApplicationMode,
  DeviceCapability,
  ManagedDevice,
  ManagedDeviceType,
} from '../../../api/generated/models';

export const keys = {
  devices: ['managed-devices'] as const,
  types: ['managed-device-types'] as const,
  policies: ['session-policies'] as const,
};

export type DeviceConfiguration = {
  sessionPolicyId: string | null;
  terminalEnabled: boolean;
  allowedApplicationModes: DeviceApplicationMode[];
  checkInAssurance: AuthenticationAssurance;
  checkOutAssurance: AuthenticationAssurance;
  checkoutMode: CheckoutMode;
  capabilities: DeviceCapability[];
};

export type Confirmation =
  { kind: 'revoke' | 'delete'; device: ManagedDevice } | { kind: 'delete-type'; type: ManagedDeviceType } | null;
