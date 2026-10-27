import { useState } from 'react';
import { Button, InlineNotification, Tag } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountSummary } from '../../../api/generated/models';
import { getAccount, resetAccountSecondFactors } from '../../../api/generated/accounts/accounts';
import { DestructiveActionDialog } from '../../../app/DestructiveActionDialog';
import { formatDateTime } from '../../../app/dateTime';
import { peopleKeys } from '../queries';
import { AuthenticationMethod, DetailSection } from '../PersonDetailComponents';

/** An account's second factors for people with `accounts.read`, and the reset for people with `accounts.mfa.reset`. */
export function AccountSecondFactorsSection({ account, canReset }: { account: AccountSummary; canReset: boolean }) {
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const detail = useQuery({
    queryKey: ['accounts', 'detail', account.id, account.version],
    queryFn: ({ signal }) => getAccount(account.id, { signal }),
  });
  const reset = useMutation({
    mutationFn: () => resetAccountSecondFactors(account.id, { expectedVersion: account.version }),
    onSuccess: async () => {
      setConfirming(false);
      await queryClient.invalidateQueries({ queryKey: ['accounts', 'detail', account.id] });
      await queryClient.invalidateQueries({ queryKey: peopleKeys.all });
    },
  });
  const factors = detail.data?.secondFactors;

  return (
    <DetailSection
      title="Second factors"
      meta={factors && <Tag type={factors.enrolled ? 'green' : 'gray'}>{factors.enrolled ? 'Enrolled' : 'None'}</Tag>}
      action={
        canReset && factors?.enrolled ? (
          <Button kind="danger--tertiary" size="sm" onClick={() => setConfirming(true)}>
            Reset second factors
          </Button>
        ) : undefined
      }
    >
      {detail.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Unable to load second factors"
          subtitle="Reload the page to try again."
        />
      )}
      {factors && (
        <div className="authentication-methods">
          <AuthenticationMethod
            label="Authenticator app"
            status={factors.totp ? 'Active' : 'Not set up'}
            detail={factors.totp?.lastUsedAt ? `Last used ${formatDateTime(factors.totp.lastUsedAt)}` : undefined}
            active={Boolean(factors.totp)}
          />
          <AuthenticationMethod
            label="Passkeys"
            status={factors.passkeys.length ? `${factors.passkeys.length} registered` : 'None'}
            active={factors.passkeys.length > 0}
          >
            {factors.passkeys.map((passkey) => (
              <div className="authentication-method__identity" key={passkey.id}>
                <div className="authentication-method__identity-summary">
                  <span>{passkey.name}</span>
                  <span>{passkey.lastUsedAt ? `Last used ${formatDateTime(passkey.lastUsedAt)}` : 'Never used'}</span>
                </div>
              </div>
            ))}
          </AuthenticationMethod>
          <AuthenticationMethod
            label="Recovery codes"
            status={`${factors.recoveryCodesRemaining} remaining`}
            active={factors.recoveryCodesRemaining > 0}
          />
        </div>
      )}
      <DestructiveActionDialog
        open={confirming}
        title="Reset second factors?"
        confirmLabel="Reset second factors"
        pending={reset.isPending}
        error={
          reset.isError ? 'The account may have changed, or you need to confirm your sign-in. Try again.' : undefined
        }
        onClose={() => {
          setConfirming(false);
          reset.reset();
        }}
        onConfirm={() => reset.mutate()}
      >
        <p>
          The authenticator app, passkeys and recovery codes of this account are deleted and its sessions are signed
          out. The person can sign in with their password and set up a second factor again.
        </p>
      </DestructiveActionDialog>
    </DetailSection>
  );
}
