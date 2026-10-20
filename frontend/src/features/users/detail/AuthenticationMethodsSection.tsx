import { OverflowMenu, OverflowMenuItem, Tag } from '@carbon/react';
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
    canIssuePasswordReset,
    canInvite,
    canRemovePasswordIdentity,
    canConfigurePIN,
    canRemovePINIdentity,
    canRemoveOIDCIdentity,
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
            canEditLoginEmail || canIssuePasswordReset || canInvite || canRemovePasswordIdentity ? (
              <OverflowMenu iconDescription="Actions for Local password" size="sm" flipped>
                {canEditLoginEmail && (
                  <OverflowMenuItem
                    itemText={passwordIdentity ? 'Change login email' : 'Add password login'}
                    onClick={() => ctrl.setLoginEmailModalOpen(true)}
                  />
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
                    hasDivider={canEditLoginEmail || canIssuePasswordReset || canInvite}
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
