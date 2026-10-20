import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import {
  changeOwnPassword,
  enrollOwnPin,
  removeOwnPassword,
  removeOwnPin,
  requestOwnEmailVerification,
} from '../../api/generated/authentication/authentication';
import type { AuthIdentitySummary, OIDCLoginProvider } from '../../api/generated/models';
import {
  listOIDCLoginProviders,
  startOIDCLink,
  startOIDCReauthentication,
  unlinkOwnOIDCIdentity,
} from '../../api/generated/oidc/oidc';
import { useSecretMutation } from '../../api/use-secret-mutation';
import { useLatestCallback } from '../../app/useLatestCallback';
import { authQueryKey, useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';

export type PasswordFormValues = {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
};
export type RemovePasswordFormValues = { currentPassword: string };
export type PINFormValues = { loginName: string; pin: string; confirmPIN: string };
export type OIDCLinkFormValues = { currentPassword: string };

/** Forms, mutations and dialog state for the authentication methods of the signed-in user. */
export function useProfileAuthentication() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [removePasswordModalOpen, setRemovePasswordModalOpen] = useState(false);
  const [pinModalOpen, setPINModalOpen] = useState(false);
  const [removePINModalOpen, setRemovePINModalOpen] = useState(false);
  const oidcActionButtons = useRef(new Map<string, HTMLElement>());
  const oidcUnlinkLauncher = useRef<HTMLElement | null>(null);
  const [oidcIdentityToUnlink, setOIDCIdentityToUnlink] = useState<AuthIdentitySummary | null>(null);
  const [oidcProviderToLink, setOIDCProviderToLink] = useState<OIDCLoginProvider | null>(null);

  const passwordForm = useForm<PasswordFormValues>({
    defaultValues: {
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    },
  });
  const removePasswordForm = useForm<RemovePasswordFormValues>({ defaultValues: { currentPassword: '' } });
  const pinForm = useForm<PINFormValues>({ defaultValues: { loginName: '', pin: '', confirmPIN: '' } });
  const oidcLinkForm = useForm<OIDCLinkFormValues>({ defaultValues: { currentPassword: '' } });
  const oidcProviders = useQuery({
    queryKey: ['oidc', 'login-providers'],
    queryFn: ({ signal }) => listOIDCLoginProviders({ signal }),
  });

  const passwordMutation = useSecretMutation(
    (request: Parameters<typeof changeOwnPassword>[0]) => changeOwnPassword(request),
    {
      onSuccess: () => {
        passwordForm.reset();
        setPasswordModalOpen(false);
      },
    },
  );
  const removePasswordMutation = useSecretMutation(
    (currentPassword: string) => removeOwnPassword({ currentPassword }),
    { onSuccess: () => window.location.assign('/login') },
  );
  const pinMutation = useSecretMutation(({ loginName, pin }: PINFormValues) => enrollOwnPin({ loginName, pin }), {
    onSuccess: async () => {
      pinForm.reset();
      setPINModalOpen(false);
      await queryClient.invalidateQueries({ queryKey: authQueryKey });
    },
  });
  const removePINMutation = useMutation({
    mutationFn: () => removeOwnPin(),
    onSuccess: async () => {
      setRemovePINModalOpen(false);
      await queryClient.invalidateQueries({ queryKey: authQueryKey });
    },
  });
  const emailVerificationMutation = useMutation({ mutationFn: () => requestOwnEmailVerification() });
  const linkOIDCMutation = useSecretMutation(
    ({ slug, currentPassword }: { slug: string; currentPassword: string }) =>
      startOIDCLink(slug, currentPassword ? { currentPassword } : {}),
    {
      onSuccess: (flow) => {
        oidcLinkForm.reset();
        setOIDCProviderToLink(null);
        window.location.assign(flow.authorizationUrl);
      },
    },
  );
  const reauthenticateOIDCMutation = useMutation({
    mutationFn: (slug: string) => startOIDCReauthentication(slug),
    onSuccess: (flow) => window.location.assign(flow.authorizationUrl),
  });
  const unlinkOIDCMutation = useMutation({
    mutationFn: (identityId: string) => unlinkOwnOIDCIdentity(identityId),
    onSuccess: async () => {
      setOIDCIdentityToUnlink(null);
      await queryClient.invalidateQueries({ queryKey: authQueryKey });
    },
  });
  const mayEnrollPIN = hasPermission(currentUser, PermissionId.accountspinenrollself);
  const mayRemovePIN = hasPermission(currentUser, PermissionId.accountspinremoveself);
  const mayRemovePassword = hasPermission(currentUser, PermissionId.accountspasswordremoveself);
  const mayLinkOIDC = hasPermission(currentUser, PermissionId.identitiesoidclinkself);
  const mayUnlinkOIDC = hasPermission(currentUser, PermissionId.identitiesoidcunlinkself);
  const pinIdentity = currentUser.account.authIdentities.find((identity) => identity.kind === 'pin');
  const passwordIdentity = currentUser.account.authIdentities.find((identity) => identity.kind === 'password');
  const oidcIdentities = currentUser.account.authIdentities.filter((identity) => identity.kind === 'oidc');
  const hasUsableAuthenticationMethod = currentUser.account.authIdentities.some((identity) => identity.usable);
  const freshEnoughForMethods = currentUser.authenticationAssurance !== 'low';

  const submitPassword = passwordForm.handleSubmit(async ({ currentPassword, newPassword }) => {
    try {
      await passwordMutation.mutateAsync({ currentPassword, newPassword });
    } catch {
      // Session expiry is handled globally; other failures render below.
    }
  });
  const submitPIN = pinForm.handleSubmit(async (values) => {
    try {
      await pinMutation.mutateAsync(values);
    } catch {
      /* rendered below */
    }
  });
  const submitRemovePassword = removePasswordForm.handleSubmit(async ({ currentPassword }) => {
    try {
      await removePasswordMutation.mutateAsync(currentPassword);
    } catch {
      /* rendered in modal */
    }
  });
  const submitOIDCLink = oidcLinkForm.handleSubmit(async ({ currentPassword }) => {
    if (!oidcProviderToLink) return;
    try {
      await linkOIDCMutation.mutateAsync({ slug: oidcProviderToLink.slug, currentPassword });
    } catch {
      /* rendered in modal */
    }
  });

  const closePasswordModal = () => {
    passwordForm.reset();
    passwordMutation.reset();
    setPasswordModalOpen(false);
  };
  const closeRemovePasswordModal = () => {
    removePasswordForm.reset();
    removePasswordMutation.reset();
    setRemovePasswordModalOpen(false);
  };
  const closePINModal = () => {
    pinForm.reset({ loginName: pinIdentity?.displayIdentifier ?? '', pin: '', confirmPIN: '' });
    pinMutation.reset();
    setPINModalOpen(false);
  };
  const closeOIDCLinkModal = () => {
    oidcLinkForm.reset();
    linkOIDCMutation.reset();
    setOIDCProviderToLink(null);
  };

  const requestCloseRemovePassword = useLatestCallback(() => {
    if (!removePasswordMutation.isPending) closeRemovePasswordModal();
    return false;
  });
  const requestCloseRemovePIN = useLatestCallback(() => {
    if (!removePINMutation.isPending) setRemovePINModalOpen(false);
    return false;
  });

  return {
    closeOIDCLinkModal,
    closePINModal,
    closePasswordModal,
    closeRemovePasswordModal,
    emailVerificationMutation,
    freshEnoughForMethods,
    hasUsableAuthenticationMethod,
    linkOIDCMutation,
    mayEnrollPIN,
    mayLinkOIDC,
    mayRemovePIN,
    mayRemovePassword,
    mayUnlinkOIDC,
    oidcActionButtons,
    oidcIdentities,
    oidcIdentityToUnlink,
    oidcLinkForm,
    oidcProviderToLink,
    oidcProviders,
    oidcUnlinkLauncher,
    passwordForm,
    passwordIdentity,
    passwordModalOpen,
    passwordMutation,
    pinForm,
    pinIdentity,
    pinModalOpen,
    pinMutation,
    reauthenticateOIDCMutation,
    removePINModalOpen,
    removePINMutation,
    removePasswordForm,
    removePasswordModalOpen,
    removePasswordMutation,
    requestCloseRemovePIN,
    requestCloseRemovePassword,
    setOIDCIdentityToUnlink,
    setOIDCProviderToLink,
    setPINModalOpen,
    setPasswordModalOpen,
    setRemovePINModalOpen,
    setRemovePasswordModalOpen,
    submitOIDCLink,
    submitPIN,
    submitPassword,
    submitRemovePassword,
    unlinkOIDCMutation,
  };
}

export type ProfileAuthentication = ReturnType<typeof useProfileAuthentication>;
