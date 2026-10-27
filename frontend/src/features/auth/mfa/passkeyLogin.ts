import { completePasskeyLogin, startPasskeyLogin } from '../../../api/generated/authentication/authentication';
import { getPasskeyCredential } from './webauthn';

/** Usernameless sign-in with a discoverable passkey; the caller reloads the current user afterwards. */
export async function signInWithPasskey(): Promise<void> {
  const options = await startPasskeyLogin();
  await completePasskeyLogin({ credential: await getPasskeyCredential(options) });
}

export { describeAuthenticationError } from './webauthn';
