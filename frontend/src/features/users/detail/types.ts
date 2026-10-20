export type ConfirmKind =
  | 'delete-person'
  | 'delete-account'
  | 'disable-account'
  | 'reset-password'
  | 'invite'
  | 'pin-setup'
  | 'remove-auth-method'
  | null;
export type AccountEmailForm = { loginEmail: string };
export type AccountPasswordForm = { newPassword: string; confirmPassword: string };
export type AccountPINForm = { loginName: string; pin: string; confirmPIN: string };
export type PersonDetailTab =
  'overview' | 'personal-information' | 'account-access' | 'roles-permissions' | 'makerspace-status';
