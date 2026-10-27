import { Suspense, useEffect, useRef, useState } from 'react';
import {
  Button,
  Header,
  HeaderGlobalAction,
  HeaderGlobalBar,
  HeaderMenuButton,
  HeaderName,
  HeaderPanel,
  InlineNotification,
  SideNav,
  SkipToContent,
  Stack,
  Tag,
  Theme,
} from '@carbon/react';
import { Logout, UserAvatar } from '@carbon/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import {
  getGetLaborordnungPDFUrl,
  requestOwnLaborordnungConfirmation,
} from '../api/generated/laborordnung/laborordnung';
import { evaluateVisitorAdmission } from '../api/generated/visitor-enrollment/visitor-enrollment';
import { authQueryKey, useCurrentUser, useLogout } from '../features/auth/auth';
import { NotificationAction, NotificationPanel } from '../features/notifications/NotificationBell';
import { PersonAvatar } from '../features/users/PersonAvatar';
import { BrandMark } from './BrandMark';
import { AppNavigation } from './AppNavigation';
import { FullPageLoading } from './PageState';
import { useBranding } from '../features/branding/branding';

const NARROW_SHELL_QUERY = '(max-width: 65.98rem)';

function currentNarrowState(): boolean {
  return typeof window.matchMedia === 'function' ? window.matchMedia(NARROW_SHELL_QUERY).matches : false;
}

export function AppShell() {
  const currentUser = useCurrentUser();
  const branding = useBranding();
  const queryClient = useQueryClient();
  // The dialog is loaded only when needed; afterwards /auth/me reports the raised assurance and the full permissions.
  const confirmSecondFactor = async () => {
    const { promptReauthentication } = await import('../features/auth/mfa/promptReauthentication');
    if (await promptReauthentication({ requiredAssurance: 'strong_mfa' })) {
      await queryClient.invalidateQueries({ queryKey: authQueryKey });
    }
  };
  const logoutMutation = useLogout();
  const location = useLocation();
  const navigate = useNavigate();
  const [isNarrow, setIsNarrow] = useState(currentNarrowState);
  const [sideNavExpanded, setSideNavExpanded] = useState(() => !currentNarrowState());
  const [profilePanelOpen, setProfilePanelOpen] = useState(false);
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const profileActionRef = useRef<HTMLButtonElement>(null);
  const notificationActionRef = useRef<HTMLButtonElement>(null);
  const profilePanelRef = useRef<HTMLDivElement>(null);
  const labRulesRequest = useMutation({
    mutationFn: () => requestOwnLaborordnungConfirmation(),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: authQueryKey }),
  });
  const admissionRequest = useMutation({
    mutationFn: () => evaluateVisitorAdmission(),
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: authQueryKey }),
  });
  const useAdmissionAction = currentUser.laborordnungStatus.mode === 'blocking' && Boolean(currentUser.managedDevice);

  const displayName = `${currentUser.person.firstName} ${currentUser.person.lastName}`;

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') {
      return;
    }
    const media = window.matchMedia(NARROW_SHELL_QUERY);
    const handleChange = (event: MediaQueryListEvent) => {
      setIsNarrow(event.matches);
      setSideNavExpanded(!event.matches);
    };
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    setProfilePanelOpen(false);
    setNotificationPanelOpen(false);
    if (isNarrow) {
      setSideNavExpanded(false);
    }
  }, [isNarrow, location.pathname]);

  const handleNavigation = () => {
    if (!isNarrow) return;
    setSideNavExpanded(false);
    window.requestAnimationFrame(() => {
      document.getElementById('main-content')?.focus();
    });
  };

  return (
    <div className="app-shell">
      <Theme theme="g100">
        <Header aria-label={branding.identity.applicationName}>
          <SkipToContent
            onClick={(event) => {
              event.preventDefault();
              document.getElementById('main-content')?.focus();
            }}
          />
          <HeaderMenuButton
            aria-label={sideNavExpanded ? 'Close navigation' : 'Open navigation'}
            isActive={sideNavExpanded}
            isCollapsible
            onClick={() => setSideNavExpanded((expanded) => !expanded)}
          />
          <HeaderName as={Link} to="/dashboard" prefix="" className="app-header__brand">
            <BrandMark kind="compact" className="app-header__logo" />
            <span className="app-header__wordmark">
              <span>{branding.identity.legalOrganizationName}</span>
              <strong>{branding.identity.displayName}</strong>
            </span>
          </HeaderName>
          <HeaderGlobalBar>
            <span className="header-account__name">{displayName}</span>
            <NotificationAction
              expanded={notificationPanelOpen}
              actionRef={notificationActionRef}
              onToggle={() => {
                setProfilePanelOpen(false);
                setNotificationPanelOpen((open) => !open);
              }}
            />
            <HeaderGlobalAction
              aria-label={`${profilePanelOpen ? 'Close' : 'Open'} profile menu for ${displayName}`}
              tooltipAlignment="end"
              isActive={profilePanelOpen}
              ref={profileActionRef}
              onClick={() => {
                setNotificationPanelOpen(false);
                setProfilePanelOpen((open) => !open);
              }}
            >
              {currentUser.person.profileImage ? (
                <PersonAvatar
                  firstName={currentUser.person.firstName}
                  lastName={currentUser.person.lastName}
                  profileImage={currentUser.person.profileImage}
                  size="sm"
                  decorative
                />
              ) : (
                <UserAvatar size={20} />
              )}
            </HeaderGlobalAction>
          </HeaderGlobalBar>
          <NotificationPanel
            expanded={notificationPanelOpen}
            actionRef={notificationActionRef}
            onClose={() => setNotificationPanelOpen(false)}
          />
          <HeaderPanel
            expanded={profilePanelOpen}
            className="profile-panel"
            ref={profilePanelRef}
            onHeaderPanelFocus={() => {
              const restoreFocus = profilePanelRef.current?.contains(document.activeElement);
              setProfilePanelOpen(false);
              if (restoreFocus) {
                profileActionRef.current?.focus();
              }
            }}
          >
            <Stack gap={5} className="profile-panel__content">
              <div>
                <p className="profile-panel__name">{displayName}</p>
                {(currentUser.person.email || currentUser.person.phone) && (
                  <p className="profile-panel__email">{currentUser.person.email ?? currentUser.person.phone}</p>
                )}
              </div>
              <Tag type={currentUser.account.status === 'enabled' ? 'green' : 'gray'}>
                {currentUser.account.status === 'enabled' ? 'Active' : 'Inactive'}
              </Tag>
              <Button kind="ghost" size="sm" onClick={() => navigate('/profile')}>
                View profile
              </Button>
              <Button
                kind="ghost"
                size="sm"
                renderIcon={Logout}
                disabled={logoutMutation.isPending}
                onClick={() => logoutMutation.mutate()}
              >
                {logoutMutation.isPending
                  ? 'Ending staff session…'
                  : currentUser.session.postSessionDestination === 'visitor_terminal'
                    ? 'Return to public kiosk'
                    : 'Sign out'}
              </Button>
              {logoutMutation.isError && (
                <InlineNotification
                  kind="error"
                  lowContrast
                  hideCloseButton
                  title="Sign out failed"
                  subtitle="Sign-out could not be confirmed. Check the connection and try again."
                />
              )}
            </Stack>
          </HeaderPanel>
          <SideNav
            aria-label="Primary navigation"
            expanded={sideNavExpanded}
            isFixedNav
            isPersistent={false}
            onOverlayClick={() => setSideNavExpanded(false)}
          >
            <AppNavigation currentUser={currentUser} legal={branding.legal} onNavigate={handleNavigation} />
          </SideNav>
        </Header>
      </Theme>

      <main
        id="main-content"
        tabIndex={-1}
        className={`app-main${sideNavExpanded && !isNarrow ? ' app-main--nav-expanded' : ''}`}
      >
        {currentUser.authentication.mfaRequired &&
          currentUser.authentication.mfaEnrolled &&
          currentUser.authentication.assurance !== 'strong_mfa' && (
            <section className="lab-rules-warning" aria-label="Second factor confirmation">
              <InlineNotification
                kind="info"
                lowContrast
                hideCloseButton
                title="Some of your permissions need a second factor"
                subtitle="This session was signed in without one, so those permissions are unavailable until you confirm it's you."
              />
              <div className="button-cluster">
                <Button kind="primary" size="sm" onClick={() => void confirmSecondFactor()}>
                  Confirm with second factor
                </Button>
              </div>
            </section>
          )}
        {currentUser.laborordnungStatus.actionRequired && currentUser.laborordnungStatus.currentVersion && (
          <section className="lab-rules-warning" aria-label="Lab Rules action required">
            <InlineNotification
              kind="warning"
              lowContrast
              hideCloseButton
              title={
                currentUser.laborordnungStatus.mode === 'blocking'
                  ? 'Current Lab Rules required for admission'
                  : 'Your Lab Rules confirmation is outdated'
              }
              subtitle={`Review revision ${currentUser.laborordnungStatus.currentVersion.humanRevision}. Normal application access remains available${currentUser.laborordnungStatus.mode === 'warning' ? '' : ', but admission remains blocked until physical confirmation'}.`}
            />
            <div className="button-cluster">
              <Button
                kind="tertiary"
                size="sm"
                href={getGetLaborordnungPDFUrl(currentUser.laborordnungStatus.currentVersion.id)}
                target="_blank"
              >
                View current Lab Rules PDF
              </Button>
              <Button
                kind="primary"
                size="sm"
                disabled={
                  Boolean(currentUser.laborordnungStatus.requestId) ||
                  labRulesRequest.isPending ||
                  admissionRequest.isPending
                }
                onClick={() => (useAdmissionAction ? admissionRequest.mutate() : labRulesRequest.mutate())}
              >
                {currentUser.laborordnungStatus.requestId
                  ? 'Signature confirmation requested'
                  : labRulesRequest.isPending || admissionRequest.isPending
                    ? 'Requesting…'
                    : useAdmissionAction
                      ? 'Request admission'
                      : 'Request signature confirmation'}
              </Button>
            </div>
            {labRulesRequest.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Request not created"
                subtitle="Try again or contact a supervisor."
              />
            )}
            {admissionRequest.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Admission not evaluated"
                subtitle="This action requires an approved visitor kiosk."
              />
            )}
          </section>
        )}
        <Suspense fallback={<FullPageLoading label="Loading page" />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
