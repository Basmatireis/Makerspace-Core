import type { WebAuthnOptions } from '../../../api/generated/models';
import { ApiError } from '../../../api/http-client';

export function canUsePasskeys(): boolean {
  return typeof window.PublicKeyCredential !== 'undefined';
}

/** Own base64url and ceremony helpers: the API exchanges binary WebAuthn members as unpadded base64url strings. */

export function base64UrlToBuffer(value: string): ArrayBuffer {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes.buffer;
}

export function bufferToBase64Url(buffer: ArrayBuffer | ArrayBufferView): string {
  const bytes =
    buffer instanceof ArrayBuffer
      ? new Uint8Array(buffer)
      : new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

type Descriptor = { id: string } & Record<string, unknown>;
type PublicKeyOptions = Record<string, unknown> & {
  challenge: string;
  user?: { id: string } & Record<string, unknown>;
  excludeCredentials?: Descriptor[];
  allowCredentials?: Descriptor[];
};

function decodeDescriptors(descriptors: Descriptor[] | undefined) {
  return descriptors?.map((descriptor) => ({ ...descriptor, id: base64UrlToBuffer(descriptor.id) }));
}

export function decodeCreationOptions(options: WebAuthnOptions): PublicKeyCredentialCreationOptions {
  const publicKey = options.publicKey as PublicKeyOptions;
  return {
    ...publicKey,
    challenge: base64UrlToBuffer(publicKey.challenge),
    user: { ...publicKey.user, id: base64UrlToBuffer(publicKey.user?.id ?? '') },
    excludeCredentials: decodeDescriptors(publicKey.excludeCredentials),
  } as unknown as PublicKeyCredentialCreationOptions;
}

export function decodeRequestOptions(options: WebAuthnOptions): PublicKeyCredentialRequestOptions {
  const publicKey = options.publicKey as PublicKeyOptions;
  return {
    ...publicKey,
    challenge: base64UrlToBuffer(publicKey.challenge),
    allowCredentials: decodeDescriptors(publicKey.allowCredentials),
  } as unknown as PublicKeyCredentialRequestOptions;
}

/** `PublicKeyCredential.toJSON()` where the browser has it, otherwise the same shape built by hand. */
export function serializeCredential(credential: PublicKeyCredential): Record<string, unknown> {
  if (typeof credential.toJSON === 'function') return credential.toJSON() as unknown as Record<string, unknown>;
  const response = credential.response;
  const base = {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
  };
  if ('attestationObject' in response) {
    const attestation = response as AuthenticatorAttestationResponse;
    return {
      ...base,
      response: {
        clientDataJSON: bufferToBase64Url(attestation.clientDataJSON),
        attestationObject: bufferToBase64Url(attestation.attestationObject),
        transports: attestation.getTransports?.() ?? [],
      },
    };
  }
  const assertion = response as AuthenticatorAssertionResponse;
  return {
    ...base,
    response: {
      clientDataJSON: bufferToBase64Url(assertion.clientDataJSON),
      authenticatorData: bufferToBase64Url(assertion.authenticatorData),
      signature: bufferToBase64Url(assertion.signature),
      userHandle: assertion.userHandle ? bufferToBase64Url(assertion.userHandle) : null,
    },
  };
}

async function runCeremony(promise: Promise<Credential | null>): Promise<Record<string, unknown>> {
  const credential = await promise;
  if (!credential) throw new DOMException('No credential was returned.', 'NotAllowedError');
  return serializeCredential(credential as PublicKeyCredential);
}

export function createPasskeyCredential(options: WebAuthnOptions) {
  return runCeremony(navigator.credentials.create({ publicKey: decodeCreationOptions(options) }));
}

export function getPasskeyCredential(options: WebAuthnOptions) {
  return runCeremony(navigator.credentials.get({ publicKey: decodeRequestOptions(options) }));
}

/** User-facing text for a failed passkey ceremony or API call; never includes server details. */
export function describeAuthenticationError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError' || error.name === 'AbortError') {
      return 'The passkey prompt was cancelled or timed out. Try again.';
    }
    if (error.name === 'InvalidStateError') return 'This authenticator already holds a passkey for your account.';
    if (error.name === 'NotSupportedError') return 'This device or browser cannot use passkeys.';
  }
  if (error instanceof ApiError) {
    const code = (error.data as { code?: string } | undefined)?.code;
    if (error.status === 429 || code === 'second_factor_rate_limited') {
      return 'Too many attempts. Wait a moment before trying again.';
    }
    if (code === 'second_factor_invalid') return 'That code is not correct.';
    if (code === 'passkey_invalid') return 'That passkey was not accepted.';
    if (code === 'passkey_clone_suspected') return 'That passkey was refused because it may have been copied.';
    if (code === 'passkey_already_registered') return 'That passkey is already registered.';
    if (code === 'second_factor_pending_invalid') return 'This sign-in expired. Start again.';
    if (code === 'invalid_credentials' || error.status === 401) return 'The credentials are incorrect.';
  }
  return 'Something went wrong. Try again.';
}

export function isPendingLoginExpired(error: unknown): boolean {
  return (
    error instanceof ApiError && (error.data as { code?: string } | undefined)?.code === 'second_factor_pending_invalid'
  );
}
