import { Button, InlineNotification, OverflowMenu, OverflowMenuItem, Tag } from '@carbon/react';
import { Link } from 'react-router-dom';
import { useCurrentUser } from '../auth/auth';
import { AuthenticationMethod, DetailSection } from '../users/PersonDetailComponents';
import type { ProfileAuthentication } from './useProfileAuthentication';

export function AuthenticationMethodsSection({ authentication }: { authentication: ProfileAuthentication }) {
  const currentUser = useCurrentUser();
  const {
    setPasswordModalOpen,
    setRemovePasswordModalOpen,
    setPINModalOpen,
    setRemovePINModalOpen,
    oidcActionButtons,
    oidcUnlinkLauncher,
    setOIDCIdentityToUnlink,
    setOIDCProviderToLink,
    passwordForm,
    removePasswordForm,
    pinForm,
    oidcLinkForm,
    oidcProviders,
    passwordMutation,
    removePasswordMutation,
    pinMutation,
    removePINMutation,
    emailVerificationMutation,
    linkOIDCMutation,
    reauthenticateOIDCMutation,
    unlinkOIDCMutation,
    mayEnrollPIN,
    mayRemovePIN,
    mayRemovePassword,
    mayLinkOIDC,
    mayUnlinkOIDC,
    pinIdentity,
    passwordIdentity,
    oidcIdentities,
    hasUsableAuthenticationMethod,
    freshEnoughForMethods,
  } = authentication;

  return (
    <DetailSection
      title="Authentication methods"
      meta={!hasUsableAuthenticationMethod ? <Tag type="gray">No login methods</Tag> : undefined}
    >
      {!freshEnoughForMethods && (
        <InlineNotification
          kind="info"
          lowContrast
          hideCloseButton
          title="Recent authentication required"
          subtitle="Use a password or an already linked OIDC provider before changing authentication methods. PIN alone is insufficient."
        />
      )}
      {passwordMutation.isSuccess && (
        <InlineNotification
          kind="success"
          lowContrast
          hideCloseButton
          title="Password changed"
          subtitle="Your other sessions have been signed out."
        />
      )}
      {pinMutation.isSuccess && (
        <InlineNotification
          kind="success"
          lowContrast
          hideCloseButton
          title="PIN method updated"
          subtitle="Other sessions were signed out."
        />
      )}
      {emailVerificationMutation.isSuccess && (
        <InlineNotification
          kind="success"
          lowContrast
          hideCloseButton
          title="Verification code sent"
          subtitle="Check your login email and enter the code on the verification page."
        />
      )}
      {emailVerificationMutation.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Verification email not sent"
          subtitle="Email delivery may be unavailable. Try again later."
        />
      )}
      {reauthenticateOIDCMutation.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="Reauthentication failed"
          subtitle="Use an enabled provider already linked to your account."
        />
      )}
      {unlinkOIDCMutation.isError && (
        <InlineNotification
          kind="error"
          lowContrast
          hideCloseButton
          title="External identity not removed"
          subtitle="Try again after reauthenticating."
        />
      )}
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
                  : currentUser.account.passwordStatus === 'reset_required'
                    ? 'Reset required'
                    : 'Not configured'
          }
          detail={passwordIdentity?.displayIdentifier ?? undefined}
          active={passwordIdentity?.usable ?? false}
          warning={currentUser.account.passwordStatus === 'reset_required'}
          action={
            passwordIdentity ? (
              <OverflowMenu iconDescription="Actions for Local password" size="sm" flipped>
                <OverflowMenuItem
                  itemText="Change password"
                  onClick={() => {
                    passwordMutation.reset();
                    passwordForm.reset();
                    setPasswordModalOpen(true);
                  }}
                />
                {mayRemovePassword && (
                  <OverflowMenuItem
                    isDelete
                    hasDivider
                    itemText="Remove password method"
                    onClick={() => {
                      removePasswordMutation.reset();
                      removePasswordForm.reset();
                      setRemovePasswordModalOpen(true);
                    }}
                  />
                )}
              </OverflowMenu>
            ) : undefined
          }
        >
          {passwordIdentity && !passwordIdentity.verifiedAt && (
            <div className="authentication-method__identity">
              <div className="authentication-method__identity-summary">
                <span>Email verification</span>
                <span>Not verified</span>
              </div>
              <div className="button-cluster">
                <Button
                  kind="tertiary"
                  size="sm"
                  disabled={emailVerificationMutation.isPending}
                  onClick={() => emailVerificationMutation.mutate()}
                >
                  {emailVerificationMutation.isPending ? 'Sending…' : 'Send code'}
                </Button>
                <Button
                  as={Link}
                  kind="ghost"
                  size="sm"
                  to={`/verify-email?email=${encodeURIComponent(passwordIdentity.displayIdentifier ?? '')}`}
                >
                  Enter code
                </Button>
              </div>
            </div>
          )}
        </AuthenticationMethod>

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
            mayEnrollPIN || (pinIdentity && mayRemovePIN) ? (
              <OverflowMenu iconDescription="Actions for Username and PIN" size="sm" flipped>
                {mayEnrollPIN && (
                  <OverflowMenuItem
                    itemText={pinIdentity ? 'Set new username and PIN' : 'Add username and PIN'}
                    onClick={() => {
                      pinMutation.reset();
                      pinForm.reset({
                        loginName: pinIdentity?.displayIdentifier ?? '',
                        pin: '',
                        confirmPIN: '',
                      });
                      setPINModalOpen(true);
                    }}
                  />
                )}
                {pinIdentity && mayRemovePIN && (
                  <OverflowMenuItem
                    isDelete
                    hasDivider={mayEnrollPIN}
                    itemText="Remove PIN method"
                    onClick={() => {
                      removePINMutation.reset();
                      setRemovePINModalOpen(true);
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
          action={
            mayLinkOIDC && oidcProviders.data && oidcProviders.data.items.length > 0 ? (
              <OverflowMenu iconDescription="Actions for OIDC / SSO" size="sm" flipped>
                {oidcProviders.data.items.map((provider) => (
                  <OverflowMenuItem
                    key={provider.slug}
                    itemText={`Link ${provider.displayName}`}
                    onClick={() => {
                      oidcLinkForm.reset();
                      linkOIDCMutation.reset();
                      setOIDCProviderToLink(provider);
                    }}
                  />
                ))}
              </OverflowMenu>
            ) : undefined
          }
        >
          {oidcIdentities.map((identity) => (
            <div className="authentication-method__identity" key={identity.id}>
              <div className="authentication-method__identity-summary">
                <span>{identity.displayIdentifier ?? 'OIDC provider'}</span>
                <span>{identity.disabledAt ? 'Disabled' : identity.usable ? 'Active' : 'Provider unavailable'}</span>
                {identity.providerSlug && <code>{identity.providerSlug}</code>}
              </div>
              {(identity.providerSlug && identity.usable) || mayUnlinkOIDC ? (
                <OverflowMenu
                  ref={(node) => {
                    if (node) oidcActionButtons.current.set(identity.id, node);
                    else oidcActionButtons.current.delete(identity.id);
                  }}
                  iconDescription={`Actions for ${identity.displayIdentifier ?? 'OIDC identity'}`}
                  size="sm"
                  flipped
                >
                  {identity.providerSlug && identity.usable && (
                    <OverflowMenuItem
                      itemText={`Reauthenticate with ${identity.displayIdentifier ?? 'OIDC'}`}
                      onClick={() => reauthenticateOIDCMutation.mutate(identity.providerSlug!)}
                    />
                  )}
                  {mayUnlinkOIDC && (
                    <OverflowMenuItem
                      isDelete
                      hasDivider={Boolean(identity.providerSlug && identity.usable)}
                      itemText="Unlink identity"
                      onClick={() => {
                        oidcUnlinkLauncher.current = oidcActionButtons.current.get(identity.id) ?? null;
                        unlinkOIDCMutation.reset();
                        setOIDCIdentityToUnlink(identity);
                      }}
                    />
                  )}
                </OverflowMenu>
              ) : null}
            </div>
          ))}
        </AuthenticationMethod>
      </div>
    </DetailSection>
  );
}
