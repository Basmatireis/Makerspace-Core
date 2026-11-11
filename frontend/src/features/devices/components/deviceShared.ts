import type {
  DeviceApplicationMode,
  DeviceCapability,
  KioskAuthenticationMethod,
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
  checkInMethods: KioskAuthenticationMethod[];
  checkOutMethods: KioskAuthenticationMethod[];
  allowTapCheckout: boolean;
  offerSurveysAtCheckout: boolean;
  kioskResetSeconds: number;
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
  nfc: 'NFC reader',
  camera: 'Camera',
  qr: 'QR scanner',
  barcode: 'Barcode scanner',
  scale: 'Scale',
  label_printer: 'Label printer',
  file_upload: 'File upload',
};

/** The ways people identify at a kiosk, in the order the kiosk offers them. */
export const kioskMethodOptions: { value: KioskAuthenticationMethod; label: string; inSentence: string }[] = [
  { value: 'email_code', label: 'Email code', inSentence: 'email code' },
  { value: 'pin', label: 'PIN', inSentence: 'PIN' },
  { value: 'password', label: 'Password', inSentence: 'password' },
];

export const allKioskMethods = kioskMethodOptions.map((option) => option.value);

/** "email code, PIN or password" for use inside a sentence; an empty list reads as "nothing". */
export function describeKioskMethods(methods: KioskAuthenticationMethod[]): string {
  const words = kioskMethodOptions
    .filter((option) => methods.includes(option.value))
    .map((option) => option.inSentence);
  if (words.length === 0) return 'nothing';
  if (words.length === 1) return words[0];
  return `${words.slice(0, -1).join(', ')} or ${words[words.length - 1]}`;
}

/** Adds or removes a method and keeps the kiosk's order. */
export function toggleKioskMethod(
  methods: KioskAuthenticationMethod[],
  method: KioskAuthenticationMethod,
  checked: boolean,
): KioskAuthenticationMethod[] {
  return allKioskMethods.filter((item) => (item === method ? checked : methods.includes(item)));
}

export const devicePaths = {
  detail: (id: string) => `/settings/devices-sessions/devices/${id}`,
};

/** What a device is used as. It is only a presentation of the allowed application modes and the kiosk switch. */
export type DeviceUse = 'kiosk' | 'kiosk-staff' | 'staff' | 'other';

export const deviceUseOptions: { value: Exclude<DeviceUse, 'other'>; label: string; help: string }[] = [
  {
    value: 'kiosk',
    label: 'Kiosk',
    help: "Check-in, check-out and visitor sign-up for everyone. Staff can't sign in here.",
  },
  {
    value: 'kiosk-staff',
    label: 'Kiosk with staff sign-in',
    help: 'Starts in the kiosk; staff can sign in on top. Their session stays bound to this device.',
  },
  { value: 'staff', label: 'Staff device', help: 'Staff sign in here. No public check-in.' },
];

export function deviceUseOf(
  config: Pick<DeviceConfiguration, 'allowedApplicationModes' | 'terminalEnabled'>,
): DeviceUse {
  const visitor = config.allowedApplicationModes.includes('visitor_terminal');
  const staff = config.allowedApplicationModes.includes('staff_ui');
  if (visitor && staff && config.terminalEnabled) return 'kiosk-staff';
  if (visitor && !staff && config.terminalEnabled) return 'kiosk';
  if (staff && !visitor && !config.terminalEnabled) return 'staff';
  return 'other';
}

/** Sets the allowed application modes and the kiosk switch for a use; other modes (signage player) stay as they are. */
export function applyDeviceUse(config: DeviceConfiguration, use: DeviceUse): DeviceConfiguration {
  if (use === 'other') return config;
  const modes: DeviceApplicationMode[] =
    use === 'kiosk' ? ['visitor_terminal'] : use === 'kiosk-staff' ? ['visitor_terminal', 'staff_ui'] : ['staff_ui'];
  return {
    ...config,
    allowedApplicationModes: [...modes, ...config.allowedApplicationModes.filter((mode) => mode === 'signage_player')],
    terminalEnabled: use !== 'staff',
  };
}

export const kioskResetRange = { min: 15, max: 600 } as const;

export const isKioskResetValid = (seconds: number) =>
  Number.isInteger(seconds) && seconds >= kioskResetRange.min && seconds <= kioskResetRange.max;

export const checkInMethodsProblem = 'Choose at least one way to check in.';
export const checkOutMethodsProblem = 'Choose a way to check out, or allow checking out by a tap in the list.';

/** Why the device cannot be saved yet; the server enforces the same rules and still answers 422 for the rest. */
export function configurationProblem(config: DeviceConfiguration): string | null {
  if (config.allowedApplicationModes.length === 0) return 'Choose what the device is used as.';
  if (config.terminalEnabled && !config.allowedApplicationModes.includes('visitor_terminal'))
    return 'A kiosk needs the visitor kiosk mode.';
  if (config.terminalEnabled && !config.sessionPolicyId) return 'A kiosk needs a session policy.';
  if (config.terminalEnabled && !isKioskResetValid(config.kioskResetSeconds))
    return `Enter ${kioskResetRange.min} to ${kioskResetRange.max} seconds.`;
  if (config.checkInMethods.length === 0) return checkInMethodsProblem;
  if (config.checkOutMethods.length === 0 && !config.allowTapCheckout) return checkOutMethodsProblem;
  return null;
}

function checkOutDescription(config: DeviceConfiguration): string {
  const methods = config.checkOutMethods.length > 0 ? describeKioskMethods(config.checkOutMethods) : '';
  if (!config.allowTapCheckout) return methods;
  return methods ? `${methods} or a tap in the list` : 'a tap in the list';
}

/** A plain list of what the settings add up to. */
export function describeDeviceUse(config: DeviceConfiguration): string[] {
  const visitor = config.allowedApplicationModes.includes('visitor_terminal') && config.terminalEnabled;
  const lines = [
    visitor ? 'Starts in the kiosk' : 'Starts at the sign-in screen',
    config.allowedApplicationModes.includes('staff_ui')
      ? 'Staff can sign in; the session ends when it leaves this device'
      : 'Staff sign-in is refused',
  ];
  lines.push(
    visitor
      ? `Check-in with ${describeKioskMethods(config.checkInMethods)} · check-out with ${checkOutDescription(config)}`
      : 'No check-in',
  );
  lines.push(visitor && config.offerSurveysAtCheckout ? 'Asks for feedback at check-out' : 'No feedback question');
  return lines;
}
