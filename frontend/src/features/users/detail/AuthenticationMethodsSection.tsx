import { Button, InlineNotification, OverflowMenu, OverflowMenuItem, Tag } from '@carbon/react';
import { apiErrorCode } from '../../../api/http-client';
import type { AccountSummary } from '../../../api/generated/models';
import { AuthenticationMethod, DetailSection } from '../PersonDetailComponents';
import type { getPersonDetailAccess } from './personDetailAccess';
import type { PersonDetailActions } from './usePersonDetailActions';

export function AuthenticationMethodsSection({
  account,
  access,
  ctrl,
}: {
  account: AccountSummary;
  access: ReturnType<typeof getPersonDetailAccess>;
  ctrl: PersonDetailActions;
}) {
  const {
    hasUsableAuthenticationMethod,
    passwordIdentity,
    pinIdentity,
    oidcIdentities,
    canEditLoginEmail,
    canSetPassword,
    canIssuePasswordReset,
    canInvite,
    canRemovePasswordIdentity,
    canConfigurePIN,
    canRemovePINIdentity,
    canRemoveOIDCIdentity,
    canManageEmailCode,
  } = access;
  return (
    <DetailSection
      title="Authentication methods"
      meta={!hasUsableAuthenticationMethod ? <Tag type="gray">No login methods</Tag> : undefined}
    >
      <div className="authentication-methods">
        <AuthenticationMethod
          label="Local password"
          status={
            !passwordIdentity
              ? 'Not configured'
              : passwordIdentity.disabledAt
                ? 'Disabled'
                : passwordIdentity.usable
                  ? 'Active'
                  : account.passwordStatus === 'reset_required'
                    ? 'Reset required'
                    : 'Not configured'
          }
          detail={passwordIdentity?.displayIdentifier ?? undefined}
          active={passwordIdentity?.usable ?? false}
          warning={account.passwordStatus === 'reset_required'}
          action={
            canEditLoginEmail || canSetPassword || canIssuePasswordReset || canInvite || canRemovePasswordIdentity ? (
              <OverflowMenu iconDescription="Actions for Local password" size="sm" flipped>
                {canEditLoginEmail && (
                  <OverflowMenuItem
                    itemText={passwordIdentity ? 'Change email' : 'Set login email'}
                    onClick={() => ctrl.setLoginEmailModalOpen(true)}
                  />
                )}
                {canSetPassword && (
                  <OverflowMenuItem itemText="Set password" onClick={() => ctrl.setPasswordModalOpen(true)} />
                )}
                {canIssuePasswordReset && (
                  <OverflowMenuItem itemText="Send reset code" onClick={() => ctrl.setConfirmKind('reset-password')} />
                )}
                {canInvite && (
                  <OverflowMenuItem itemText="Send invitation" onClick={() => ctrl.setConfirmKind('invite')} />
                )}
                {canRemovePasswordIdentity && (
                  <OverflowMenuItem
                    isDelete
                    hasDivider={canEditLoginEmail || canSetPassword || canIssuePasswordReset || canInvite}
                    itemText="Remove password method"
                    onClick={() => {
                      ctrl.setAuthIdentityToRemove(passwordIdentity ?? null);
                      ctrl.setConfirmKind('remove-auth-method');
                    }}
                  />
                )}
              </OverflowMenu>
            ) : undefined
          }
        />
        <AuthenticationMethod
          label="Username and PIN"
          status={
            !pinIdentity
              ? 'Not configured'
              : pinIdentity.disabledAt
                ? 'Disabled'
                : pinIdentity.usable
                  ? 'Active'
                  : 'Not configured'
          }
          detail={pinIdentity?.displayIdentifier ? `Username: ${pinIdentity.displayIdentifier}` : undefined}
          active={pinIdentity?.usable ?? false}
          action={
            canConfigurePIN || canRemovePINIdentity ? (
              <OverflowMenu iconDescription="Actions for Username and PIN" size="sm" flipped>
                {canConfigurePIN && (
                  <OverflowMenuItem
                    itemText={pinIdentity ? 'Set new username and PIN' : 'Add username and PIN'}
                    onClick={() => ctrl.setPINModalOpen(true)}
                  />
                )}
                {canConfigurePIN && (
                  <OverflowMenuItem
                    itemText={pinIdentity ? 'Create setup link' : 'Create setup link instead'}
                    onClick={() => ctrl.setConfirmKind('pin-setup')}
                  />
                )}
                {canRemovePINIdentity && (
                  <OverflowMenuItem
                    isDelete
                    hasDivider={canConfigurePIN}
                    itemText="Remove PIN method"
                    onClick={() => {
                      ctrl.setAuthIdentityToRemove(pinIdentity ?? null);
                      ctrl.setConfirmKind('remove-auth-method');
                    }}
                  />
                )}
              </OverflowMenu>
            ) : undefined
          }
        />
        <AuthenticationMethod
          label="Email code"
          status={account.emailCodeEnabled ? 'On' : 'Off'}
          detail={account.loginEmail ? undefined : 'Needs a login email'}
          active={account.emailCodeEnabled}
          action={
            canManageEmailCode ? (
              <>
                {account.emailCodeEnabled && account.loginEmail && (
                  <Button
                    kind="ghost"
                    size="sm"
                    disabled={ctrl.sendEmailCodeMutation.isPending}
                    onClick={() => ctrl.sendEmailCodeMutation.mutate()}
                  >
                    Send sign-in code
                  </Button>
                )}
                <Button
                  kind="tertiary"
                  size="sm"
                  disabled={ctrl.emailCodeMutation.isPending}
                  onClick={() => {
                    ctrl.sendEmailCodeMutation.reset();
                    ctrl.emailCodeMutation.mutate(!account.emailCodeEnabled);
                  }}
                >
                  {account.emailCodeEnabled ? 'Turn off' : 'Turn on'}
                </Button>
              </>
            ) : undefined
          }
        >
          {sendCodeFeedback(ctrl.sendEmailCodeMutation)}
        </AuthenticationMethod>
        <AuthenticationMethod
          label="OIDC / SSO"
          status={
            oidcIdentities.length
              ? `${oidcIdentities.filter((identity) => identity.usable).length} active`
              : 'Not connected'
          }
          active={oidcIdentities.some((identity) => identity.usable)}
        >
          {oidcIdentities.map((identity) => (
            <div className="authentication-method__identity" key={identity.id}>
              <div className="authentication-method__identity-summary">
                <span>{identity.displayIdentifier ?? 'OIDC provider'}</span>
                <span>{identity.disabledAt ? 'Disabled' : identity.usable ? 'Active' : 'Provider unavailable'}</span>
                {identity.providerSlug && <code>{identity.providerSlug}</code>}
              </div>
              {canRemoveOIDCIdentity && (
                <OverflowMenu
                  iconDescription={`Actions for ${identity.displayIdentifier ?? 'OIDC identity'}`}
                  size="sm"
                  flipped
                >
                  <OverflowMenuItem
                    isDelete
                    itemText="Unlink identity"
                    onClick={() => {
                      ctrl.setAuthIdentityToRemove(identity);
                      ctrl.setConfirmKind('remove-auth-method');
                    }}
                  />
                </OverflowMenu>
              )}
            </div>
          ))}
        </AuthenticationMethod>
      </div>
    </DetailSection>
  );
}

/** The outcome of mailing a sign-in code: sent, mail not delivered, or one of the explicit refusals. */
function sendCodeFeedback(mutation: PersonDetailActions['sendEmailCodeMutation']) {
  if (mutation.isSuccess) {
    return mutation.data.delivery === 'sent' ? (
      <InlineNotification
        kind="success"
        lowContrast
        hideCloseButton
        title="Code sent"
        subtitle={`Sign-in code sent to ${mutation.data.address ?? 'the login email'}`}
      />
    ) : (
      <InlineNotification
        kind="error"
        lowContrast
        hideCloseButton
        title="Code not delivered"
        subtitle="The mail could not be sent. Check the mail settings and try again."
      />
    );
  }
  if (!mutation.isError) return null;
  const code = apiErrorCode(mutation.error);
  const subtitle =
    code === 'email_code_rate_limited'
      ? 'Five codes were already requested for this address. Try again in 15 minutes.'
      : code === 'email_code_not_enabled'
        ? 'Sign-in with an emailed code is off for this account.'
        : code === 'email_code_unavailable'
          ? 'The account is disabled, must reset its password or has used up its codes.'
          : code === 'login_email_required'
            ? 'The account needs a login email first.'
            : 'The code could not be sent. Reload the person and try again.';
  return <InlineNotification kind="error" lowContrast hideCloseButton title="Code not sent" subtitle={subtitle} />;
}
