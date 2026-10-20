import { useEffect, useMemo } from 'react';
import {
  Button,
  Column,
  Grid,
  InlineNotification,
  MenuButton,
  MenuItem,
  MenuItemDivider,
  Stack,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
  Tile,
} from '@carbon/react';
import { TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useParams, useSearchParams } from 'react-router-dom';
import type { AccountSummary, Person } from '../../api/generated/models';
import { getPersonMakerspaceStatus } from '../../api/generated/people/people';
import { formatDateTime } from '../../app/dateTime';
import { PageShell } from '../../app/PageShell';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { useBranding } from '../branding/branding';
import { AccountAccessSection } from './detail/AccountAccessSection';
import { AccountDialogs } from './detail/AccountDialogs';
import { AuthenticationMethodsSection } from './detail/AuthenticationMethodsSection';
import { MakerspaceStatusSection } from './detail/MakerspaceStatusSection';
import { getPersonDetailAccess } from './detail/personDetailAccess';
import { PersonalInformationSection } from './detail/PersonalInformationSection';
import { ProfileSection } from './detail/ProfileSection';
import { RoleAndConfirmationDialogs } from './detail/RoleAndConfirmationDialogs';
import { RolesSection } from './detail/RolesSection';
import type { PersonDetailTab } from './detail/types';
import { usePersonDetailActions } from './detail/usePersonDetailActions';
import { peopleKeys, personOptions } from './queries';

type PersonDetailTabOption = {
  key: PersonDetailTab;
  label: string;
};

const personDetailTabs: readonly PersonDetailTabOption[] = [
  { key: 'overview', label: 'Overview' },
  { key: 'personal-information', label: 'Personal information' },
  { key: 'account-access', label: 'Account access' },
  { key: 'roles-permissions', label: 'Roles & permissions' },
  { key: 'makerspace-status', label: 'Makerspace status' },
];

function asAccount(value: Person['account']): AccountSummary | undefined {
  return value && typeof value === 'object' ? value : undefined;
}

export function UserDetailPage() {
  const { personId = '' } = useParams();
  const personQuery = useQuery(personOptions(personId));

  if (personQuery.isPending) return <FullPageLoading label="Loading person" />;
  if (personQuery.isError || !personQuery.data) {
    return (
      <ErrorState
        title="Unable to load person"
        message="The person may no longer exist or you may not have access."
        onRetry={() => void personQuery.refetch()}
      />
    );
  }

  return <UserDetailContent key={`${personQuery.data.id}-${personQuery.data.version}`} person={personQuery.data} />;
}

function UserDetailContent({ person }: { person: Person }) {
  const currentUser = useCurrentUser();
  const branding = useBranding();
  const statusLabel = `${branding.identity.displayName} status`;
  const [searchParams, setSearchParams] = useSearchParams();
  const account: AccountSummary | undefined = asAccount(person.account);
  const access = getPersonDetailAccess(currentUser, person, account);
  const ctrl = usePersonDetailActions({ person, account, access });
  const {
    canEditPerson,
    canReadMatriculation,
    canEditMatriculation,
    canReadAccounts,
    canReadMakerspaceStatus,
    canEditLoginEmail,
    canCreateAccount,
    canDeletePerson,
    canDisableAccount,
    canDeleteAccount,
    canAssignRole,
    canSetPassword,
    passwordIdentity,
    pinIdentity,
    canIssuePasswordReset,
    canInvite,
    canConfigurePIN,
    hasAccountActions,
    hasCredentialActions,
    hasPersonActions,
  } = access;
  const {
    editingPerson,
    setEditingPerson,
    setLoginEmailModalOpen,
    setAssignRoleOpen,
    setPasswordModalOpen,
    setPINModalOpen,
    setCreateAccountOpen,
    setConfirmKind,
    resetSent,
    resetExpiresAt,
    manualSetupUrl,
    clearResetIssue,
    mutationError,
  } = ctrl;
  const makerspaceStatusQuery = useQuery({
    queryKey: [...peopleKeys.detail(person.id), 'makerspace-status'],
    queryFn: ({ signal }) => getPersonMakerspaceStatus(person.id, { signal }),
    enabled: canReadMakerspaceStatus,
  });

  // Stable identity: the tab-normalising effect below depends on it.
  const availableTabs = useMemo(
    () =>
      personDetailTabs
        .filter((tab) => {
          if (tab.key === 'account-access') return canReadAccounts;
          if (tab.key === 'roles-permissions') return true;
          if (tab.key === 'makerspace-status') return canReadMakerspaceStatus;
          return true;
        })
        .map((tab) => (tab.key === 'makerspace-status' ? { ...tab, label: statusLabel } : tab)),
    [canReadAccounts, canReadMakerspaceStatus, statusLabel],
  );
  const requestedTab = searchParams.get('tab');
  const selectedTabIndex = Math.max(
    0,
    availableTabs.findIndex((tab) => tab.key === requestedTab),
  );
  const selectedTab = availableTabs[selectedTabIndex]?.key ?? 'overview';

  useEffect(() => {
    if (!requestedTab) return;
    if (requestedTab !== 'overview' && availableTabs.some((tab) => tab.key === requestedTab)) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete('tab');
        return next;
      },
      { replace: true },
    );
  }, [availableTabs, requestedTab, setSearchParams]);
  const selectTab = (tab: PersonDetailTab) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (tab === 'overview') next.delete('tab');
      else next.set('tab', tab);
      return next;
    });
  };

  const startEditingPerson = () => {
    setEditingPerson(true);
    selectTab('personal-information');
  };

  const startEditingAccount = () => {
    setLoginEmailModalOpen(true);
    selectTab('account-access');
  };

  const openRoleManager = () => {
    setAssignRoleOpen(true);
    selectTab('roles-permissions');
  };

  const profileSection = (
    <ProfileSection
      person={person}
      canEditProfileImage={access.canEditProfileImage}
      canUpdateProfileImage={access.canUpdateProfileImage}
      canRemoveProfileImage={access.canRemoveProfileImage}
    />
  );
  const personalInformationSection = (
    <PersonalInformationSection
      person={person}
      ctrl={ctrl}
      canEditPerson={canEditPerson}
      canReadMatriculation={canReadMatriculation}
      canEditMatriculation={canEditMatriculation}
    />
  );
  const accountAccessSection = (
    <AccountAccessSection
      person={person}
      account={account}
      canReadAccounts={canReadAccounts}
      canCreateAccount={canCreateAccount}
      canEnableAccount={access.canEnableAccount}
      enablePending={ctrl.enableMutation.isPending}
      onCreateAccount={() => setCreateAccountOpen(true)}
      onEnableAccount={() => ctrl.enableMutation.mutate()}
    />
  );
  const authenticationMethodsSection = account ? (
    <AuthenticationMethodsSection account={account} access={access} ctrl={ctrl} />
  ) : null;
  const rolesSection = (
    <RolesSection
      person={person}
      currentUser={currentUser}
      rolesById={ctrl.rolesById}
      canAssignRole={canAssignRole}
      onManageRoles={() => setAssignRoleOpen(true)}
      onRemoveRole={(role) => {
        ctrl.roleMutation.reset();
        ctrl.setRoleToRemove(role);
      }}
    />
  );
  const makerspaceStatusSection = <MakerspaceStatusSection statusLabel={statusLabel} query={makerspaceStatusQuery} />;

  const renderTabContent = (tab: PersonDetailTab) => {
    if (tab === 'personal-information') {
      return (
        <Grid className="person-detail-grid person-detail-grid--personal">
          <Column sm={4} md={3} lg={6} className="person-detail-grid__stretch-cell">
            {profileSection}
          </Column>
          <Column sm={4} md={5} lg={10} className="person-detail-grid__stretch-cell">
            {personalInformationSection}
          </Column>
        </Grid>
      );
    }
    if (tab === 'account-access') {
      return (
        <Stack gap={6}>
          {accountAccessSection}
          {authenticationMethodsSection}
        </Stack>
      );
    }
    if (tab === 'roles-permissions') return rolesSection;
    if (tab === 'makerspace-status') return makerspaceStatusSection;

    return (
      <Grid className="person-detail-grid person-detail-grid--overview">
        <Column sm={4} md={3} lg={6} className="person-detail-grid__stretch-cell">
          {profileSection}
        </Column>
        <Column sm={4} md={5} lg={10} className="person-detail-grid__stretch-cell">
          {accountAccessSection}
        </Column>
        <Column sm={4} md={3} lg={6} className="person-detail-grid__stretch-cell">
          {personalInformationSection}
        </Column>
        <Column sm={4} md={5} lg={10} className="person-detail-overview__stack">
          <Stack gap={6}>
            {authenticationMethodsSection}
            {rolesSection}
          </Stack>
        </Column>
        {canReadMakerspaceStatus && (
          <Column sm={4} md={8} lg={16}>
            {makerspaceStatusSection}
          </Column>
        )}
      </Grid>
    );
  };

  return (
    <Tabs
      selectedIndex={selectedTabIndex}
      onChange={({ selectedIndex }) => {
        const nextTab = availableTabs[selectedIndex];
        if (nextTab) selectTab(nextTab.key);
      }}
    >
      <PageShell
        title={`${person.firstName} ${person.lastName}`}
        breadcrumbs={[
          { label: 'Directory' },
          { label: 'People', to: '/people' },
          { label: `${person.firstName} ${person.lastName}` },
        ]}
        description={`Personal details, account access, and ${statusLabel.toLowerCase()}.`}
        actions={
          hasPersonActions ? (
            <MenuButton label="Actions" kind="primary" menuAlignment="bottom-end" size="md">
              {canEditPerson && !editingPerson && <MenuItem label="Edit person" onClick={startEditingPerson} />}
              {canEditPerson && !editingPerson && (hasAccountActions || hasCredentialActions) && <MenuItemDivider />}
              {canEditLoginEmail && (
                <MenuItem
                  label={passwordIdentity ? 'Change password login email' : 'Add password login'}
                  onClick={startEditingAccount}
                />
              )}
              {canCreateAccount && (
                <MenuItem
                  label="Create account"
                  onClick={() => {
                    setCreateAccountOpen(true);
                    selectTab('account-access');
                  }}
                />
              )}
              {canAssignRole && <MenuItem label="Manage roles" onClick={openRoleManager} />}
              {hasAccountActions && hasCredentialActions && <MenuItemDivider />}
              {canSetPassword && <MenuItem label="Set password" onClick={() => setPasswordModalOpen(true)} />}
              {canIssuePasswordReset && (
                <MenuItem label="Send reset code" onClick={() => setConfirmKind('reset-password')} />
              )}
              {canInvite && <MenuItem label="Send invitation" onClick={() => setConfirmKind('invite')} />}
              {canConfigurePIN && (
                <MenuItem
                  label={pinIdentity ? 'Set new username and PIN' : 'Add username and PIN'}
                  onClick={() => setPINModalOpen(true)}
                />
              )}
            </MenuButton>
          ) : undefined
        }
        tabs={
          <TabList aria-label="Person detail sections">
            {availableTabs.map((tab) => (
              <Tab key={tab.key}>{tab.label}</Tab>
            ))}
          </TabList>
        }
        className="person-detail-page"
      >
        {mutationError && (
          <InlineNotification
            kind="error"
            lowContrast
            hideCloseButton
            title="Change not completed"
            subtitle="The record may have changed. Reload it and try again."
          />
        )}
        <div className="person-detail-layout">
          <TabPanels>
            {availableTabs.map((tab) => (
              <TabPanel key={tab.key} className="person-detail-tab-panel">
                {tab.key === selectedTab ? renderTabContent(tab.key) : null}
              </TabPanel>
            ))}
          </TabPanels>

          {resetSent && !manualSetupUrl && (
            <Tile className="secret-tile">
              <Stack gap={5}>
                <InlineNotification
                  kind="success"
                  lowContrast
                  hideCloseButton
                  title="Message sent"
                  subtitle="The one-time link was sent by email."
                />
                {resetExpiresAt && <p className="section-description">Expires {formatDateTime(resetExpiresAt)}.</p>}
                <div className="form-actions">
                  <Button kind="ghost" onClick={clearResetIssue}>
                    Dismiss
                  </Button>
                </div>
              </Stack>
            </Tile>
          )}

          {(canDisableAccount || canDeleteAccount || canDeletePerson) && (
            <Tile className="danger-zone">
              <Stack gap={5}>
                <div>
                  <h2>Danger zone</h2>
                  <p className="danger-zone__description">
                    These actions affect account access or permanently remove data.
                  </p>
                </div>
                <div className="button-cluster">
                  {canDisableAccount && (
                    <Button kind="danger--tertiary" size="md" onClick={() => setConfirmKind('disable-account')}>
                      Disable account
                    </Button>
                  )}
                  {canDeleteAccount && (
                    <Button kind="danger--tertiary" size="md" onClick={() => setConfirmKind('delete-account')}>
                      Delete account
                    </Button>
                  )}
                  {canDeletePerson && (
                    <Button
                      kind="danger--tertiary"
                      size="md"
                      renderIcon={TrashCan}
                      onClick={() => setConfirmKind('delete-person')}
                    >
                      Delete person
                    </Button>
                  )}
                </div>
              </Stack>
            </Tile>
          )}
        </div>

        <AccountDialogs person={person} passwordIdentity={passwordIdentity} pinIdentity={pinIdentity} ctrl={ctrl} />
        <RoleAndConfirmationDialogs person={person} ctrl={ctrl} />
      </PageShell>
    </Tabs>
  );
}
