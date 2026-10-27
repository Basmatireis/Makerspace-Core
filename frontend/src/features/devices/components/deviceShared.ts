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

export const modeLabels: Record<DeviceApplicationMode, string> = {
  visitor_terminal: 'Visitor kiosk',
  staff_ui: 'Staff UI',
  signage_player: 'Signage player',
};

export const capabilityLabels: Record<DeviceCapability, string> = {
  nfc: 'NFC',
  camera: 'Camera',
  qr: 'QR',
  barcode: 'Barcode',
  scale: 'Scale',
  label_printer: 'Label printer',
  file_upload: 'File upload',
};

export const assuranceLabels: Record<AuthenticationAssurance, string> = {
  low: 'Low',
  normal: 'Normal',
  strong: 'Strong',
  strong_mfa: 'Strong with MFA',
};

export const checkoutModeLabels: Record<CheckoutMode, string> = {
  verified: 'Verified credential',
  public_tap: 'Public tap from Currently Here',
};

export const devicePaths = {
  detail: (id: string) => `/settings/devices-sessions/devices/${id}`,
};
