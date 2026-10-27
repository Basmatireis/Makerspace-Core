import { useState } from 'react';
import { Button, InlineNotification, Modal, Stack, Tag, TextInput } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Passkey, SecondFactorEnrollmentResult } from '../../api/generated/models';
import {
  getOwnSecondFactors,
  regenerateRecoveryCodes,
  removeOwnTotp,
  removePasskey,
  renamePasskey,
} from '../../api/generated/authentication/authentication';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { formatDateTime } from '../../app/dateTime';
import { ApiError } from '../../api/http-client';
import { PasskeyRegistrationPanel, RecoveryCodesPanel, TotpEnrollmentPanel } from '../auth/mfa/EnrollmentPanels';
import { canUsePasskeys } from '../auth/mfa/webauthn';
import { authQueryKey } from '../auth/auth';
import { AuthenticationMethod, DetailSection } from '../users/PersonDetailComponents';

const secondFactorsQueryKey = ['auth', 'second-factors'] as const;

type Dialog =
  | { kind: 'totp' }
  | { kind: 'passkey' }
  | { kind: 'rename'; passkey: Passkey }
  | { kind: 'remove-totp' }
  | { kind: 'remove-passkey'; passkey: Passkey }
  | { kind: 'regenerate' }
  | { kind: 'codes'; codes: readonly string[] }
  | null;

function errorText(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof ApiError && error.status === 403) return 'You need to confirm your sign-in to do this.';
  return 'Something went wrong. Try again.';
}

/** Self-service second factors: authenticator app, passkeys and recovery codes. */
export function SecondFactorsSection() {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [passkeyName, setPasskeyName] = useState('');
  const factors = useQuery({
    queryKey: secondFactorsQueryKey,
    queryFn: ({ signal }) => getOwnSecondFactors({ signal }),
  });

  // Enrollment and removal change what /auth/me reports (mfaEnrolled, methods), so both caches are refreshed.
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: secondFactorsQueryKey }),
      queryClient.invalidateQueries({ queryKey: authQueryKey }),
    ]);
  };
  const close = () => setDialog(null);
  const mutation = useMutation({
    mutationFn: async (action: NonNullable<Dialog>) => {
      if (action.kind === 'remove-totp') await removeOwnTotp();
      else if (action.kind === 'remove-passkey') await removePasskey(action.passkey.id);
      else if (action.kind === 'rename') await renamePasskey(action.passkey.id, { name: passkeyName.trim() });
      else if (action.kind === 'regenerate') return (await regenerateRecoveryCodes()).recoveryCodes;
      return null;
    },
    onSuccess: async (codes) => {
      await refresh();
      setDialog(codes ? { kind: 'codes', codes } : null);
    },
  });
  const enrolled = async (result: SecondFactorEnrollmentResult) => {
    await refresh();
    setDialog(result.recoveryCodes?.length ? { kind: 'codes', codes: result.recoveryCodes } : null);
  };
  const open = (next: Dialog) => {
    mutation.reset();
    if (next?.kind === 'rename') setPasskeyName(next.passkey.name);
    setDialog(next);
  };

  const summary = factors.data;
  return (
    <DetailSection
      title="Two-factor authentication"
      description="A second factor protects your account if your password is stolen."
      meta={summary && <Tag type={summary.enrolled ? 'green' : 'gray'}>{summary.enrolled ? 'On' : 'Off'}</Tag>}
    >
      {factors.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Unable to load second factors"
          subtitle="Reload the page to try again."
        />
      )}
      {summary && (
        <div className="authentication-methods">
          <AuthenticationMethod
            label="Authenticator app"
            status={summary.totp ? 'Active' : 'Not set up'}
            detail={
              summary.totp
                ? `Added ${formatDateTime(summary.totp.confirmedAt)}${
                    summary.totp.lastUsedAt ? `, last used ${formatDateTime(summary.totp.lastUsedAt)}` : ''
                  }`
                : undefined
            }
            active={Boolean(summary.totp)}
            action={
              summary.totp ? (
                <Button kind="danger--ghost" size="sm" onClick={() => open({ kind: 'remove-totp' })}>
                  Remove
                </Button>
              ) : (
                <Button kind="tertiary" size="sm" onClick={() => open({ kind: 'totp' })}>
                  Set up
                </Button>
              )
            }
          />
          <AuthenticationMethod
            label="Passkeys"
            status={summary.passkeys.length ? `${summary.passkeys.length} registered` : 'None'}
            active={summary.passkeys.length > 0}
            action={
              canUsePasskeys() ? (
                <Button kind="tertiary" size="sm" renderIcon={Add} onClick={() => open({ kind: 'passkey' })}>
                  Add passkey
                </Button>
              ) : undefined
            }
          >
            {summary.passkeys.map((passkey) => (
              <div className="authentication-method__identity" key={passkey.id}>
                <div className="authentication-method__identity-summary">
                  <span>{passkey.name}</span>
                  <span>Added {formatDateTime(passkey.createdAt)}</span>
                  <span>{passkey.lastUsedAt ? `Last used ${formatDateTime(passkey.lastUsedAt)}` : 'Never used'}</span>
                </div>
                <div className="button-cluster">
                  <Button kind="ghost" size="sm" onClick={() => open({ kind: 'rename', passkey })}>
                    Rename
                  </Button>
                  <Button kind="danger--ghost" size="sm" onClick={() => open({ kind: 'remove-passkey', passkey })}>
                    Remove
                  </Button>
                </div>
              </div>
            ))}
          </AuthenticationMethod>
          <AuthenticationMethod
            label="Recovery codes"
            status={summary.enrolled ? `${summary.recoveryCodesRemaining} remaining` : 'Not available'}
            detail="Single-use codes for when you lose your second factor."
            active={summary.enrolled && summary.recoveryCodesRemaining > 0}
            warning={summary.enrolled && summary.recoveryCodesRemaining === 0}
            action={
              summary.enrolled ? (
                <Button kind="tertiary" size="sm" onClick={() => open({ kind: 'regenerate' })}>
                  Regenerate
                </Button>
              ) : undefined
            }
          />
        </div>
      )}

      {(dialog?.kind === 'totp' || dialog?.kind === 'passkey') && (
        <Modal
          open
          passiveModal
          size="sm"
          modalHeading={dialog?.kind === 'passkey' ? 'Add a passkey' : 'Set up authenticator app'}
          onRequestClose={close}
        >
          <Stack gap={5}>
            {dialog?.kind === 'totp' && <TotpEnrollmentPanel onEnrolled={enrolled} />}
            {dialog?.kind === 'passkey' && <PasskeyRegistrationPanel onEnrolled={enrolled} />}
          </Stack>
        </Modal>
      )}
      {dialog?.kind === 'codes' && (
        <Modal
          open
          passiveModal
          size="sm"
          preventCloseOnClickOutside
          modalHeading="Recovery codes"
          onRequestClose={close}
        >
          {dialog?.kind === 'codes' && <RecoveryCodesPanel codes={dialog.codes} onDone={close} doneLabel="Done" />}
        </Modal>
      )}
      {dialog?.kind === 'rename' && (
        <Modal
          open
          size="sm"
          modalHeading="Rename passkey"
          primaryButtonText={mutation.isPending ? 'Saving…' : 'Save'}
          secondaryButtonText="Cancel"
          primaryButtonDisabled={mutation.isPending || !passkeyName.trim()}
          onRequestClose={close}
          onRequestSubmit={() => dialog && mutation.mutate(dialog)}
        >
          <Stack gap={5}>
            {mutation.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Unable to rename"
                subtitle={errorText(mutation.error)}
              />
            )}
            <TextInput
              id="rename-passkey"
              labelText="Passkey name"
              value={passkeyName}
              maxLength={100}
              onChange={(event) => setPasskeyName(event.target.value)}
            />
          </Stack>
        </Modal>
      )}
      <DestructiveActionDialog
        open={dialog?.kind === 'remove-totp' || dialog?.kind === 'remove-passkey' || dialog?.kind === 'regenerate'}
        title={
          dialog?.kind === 'regenerate'
            ? 'Regenerate recovery codes'
            : dialog?.kind === 'remove-passkey'
              ? 'Remove passkey'
              : 'Remove authenticator app'
        }
        confirmLabel={dialog?.kind === 'regenerate' ? 'Regenerate' : 'Remove'}
        pending={mutation.isPending}
        error={errorText(mutation.error)}
        onConfirm={() => dialog && mutation.mutate(dialog)}
        onClose={close}
      >
        <p>
          {dialog?.kind === 'regenerate'
            ? 'Your current recovery codes stop working. New codes are shown once.'
            : 'Your other sessions are signed out. If this is your last second factor, your recovery codes are deleted and some roles may require you to set one up again.'}
        </p>
      </DestructiveActionDialog>
    </DetailSection>
  );
}
