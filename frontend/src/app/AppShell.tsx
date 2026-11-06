import { lazy, Suspense, useEffect, useRef, useState } from 'react';
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
import { Calendar, Help, Logout, UserAvatar } from '@carbon/icons-react';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { authQueryKey, useCurrentUser, useLogout } from '../features/auth/auth';
import { DemoBanner } from '../features/demo/DemoBanner';
import { GuideProvider } from '../features/guides/GuideProvider';
import { NotificationAction, NotificationPanel } from '../features/notifications/NotificationBell';
import { NotificationAlertHost } from '../features/notifications/NotificationAlertHost';
import { PersonAvatar } from '../features/users/PersonAvatar';
import { BrandMark } from './BrandMark';
import { setColorScheme, useColorScheme } from './colorScheme';
import { AppNavigation } from './AppNavigation';
import { FullPageLoading } from './PageState';
import { ToastProvider } from './toasts';
import { useBranding } from '../features/branding/branding';

// The confirmation form pulls in the PDF viewer, so it loads only for people who have to confirm.
const LabRulesConfirmModal = lazy(() => import('../features/laborordnung/confirm/LabRulesConfirmModal'));
// The first-sign-in tour offer asks the server about progress, so it loads (and fetches) after the shell is up.
const GuideOffer = lazy(() => import('../features/guides/GuideOffer'));
// The notification consent question replaces the application until it is answered, so it loads only for those people.
const ConsentGate = lazy(() => import('../features/mynotifications/ConsentGate'));
// The calendar subscription dialog loads when someone opens it from the profile menu or a `?calendar=subscription` link.
const CalendarSubscriptionDialog = lazy(() => import('../features/profile/CalendarSubscriptionDialog'));

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
  const dark = useColorScheme() === 'dark';
  const location = useLocation();
  const navigate = useNavigate();
  const [isNarrow, setIsNarrow] = useState(currentNarrowState);
  const [sideNavExpanded, setSideNavExpanded] = useState(() => !currentNarrowState());
  const [profilePanelOpen, setProfilePanelOpen] = useState(false);
  const [notificationPanelOpen, setNotificationPanelOpen] = useState(false);
  const [calendarDialogOpen, setCalendarDialogOpen] = useState(false);
  // Any page can ask for the dialog with `?calendar=subscription`, for example the Open Days page.
  const calendarLinked = new URLSearchParams(location.search).get('calendar') === 'subscription';
  const closeCalendarDialog = () => {
    setCalendarDialogOpen(false);
    if (!calendarLinked) return;
    const search = new URLSearchParams(location.search);
    search.delete('calendar');
    const rest = search.toString();
    void navigate(
      { pathname: location.pathname, search: rest ? `?${rest}` : '', hash: location.hash },
      { replace: true },
    );
  };
  const profileActionRef = useRef<HTMLButtonElement>(null);
  const notificationActionRef = useRef<HTMLButtonElement>(null);
  const profilePanelRef = useRef<HTMLDivElement>(null);
  // "Later" (warning mode) hides the modal for this page load only; nothing is stored.
  const [labRulesDeferred, setLabRulesDeferred] = useState(false);
  const labRules = currentUser.laborordnungStatus;
  const showLabRulesModal =
    labRules.actionRequired && labRules.currentVersion !== null && (labRules.mode === 'blocking' || !labRulesDeferred);

  // Right after sign-in the consent question takes the place of the application: no navigation, no dialogs.
  const consentRequired = currentUser.notificationConsentRequired === true;

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
    <ToastProvider>
      <GuideProvider>
        <div className="app-shell">
          <Theme theme="g100">
            <Header aria-label={branding.identity.applicationName}>
              <SkipToContent
                onClick={(event) => {
                  event.preventDefault();
                  document.getElementById('main-content')?.focus();
                }}
              />
              {!consentRequired && (
                <HeaderMenuButton
                  aria-label={sideNavExpanded ? 'Close navigation' : 'Open navigation'}
                  isActive={sideNavExpanded}
                  isCollapsible
                  onClick={() => setSideNavExpanded((expanded) => !expanded)}
                />
              )}
              <HeaderName as={Link} to="/dashboard" prefix="" className="app-header__brand">
                <BrandMark kind="compact" className="app-header__logo" />
                <span className="app-header__wordmark">
                  <span>{branding.identity.legalOrganizationName}</span>
                  <strong>{branding.identity.displayName}</strong>
                </span>
              </HeaderName>
              <HeaderGlobalBar>
                <span className="header-account__name">{displayName}</span>
                {!consentRequired && (
                  <>
                    <HeaderGlobalAction
                      aria-label="Help"
                      tooltipAlignment="end"
                      data-guide="header-help"
                      onClick={() => navigate('/help')}
                    >
                      <Help size={20} />
                    </HeaderGlobalAction>
                    <NotificationAction
                      expanded={notificationPanelOpen}
                      actionRef={notificationActionRef}
                      onToggle={() => {
                        setProfilePanelOpen(false);
                        setNotificationPanelOpen((open) => !open);
                      }}
                    />
                  </>
                )}
                <HeaderGlobalAction
                  aria-label={`${profilePanelOpen ? 'Close' : 'Open'} profile menu for ${displayName}`}
                  data-guide="header-profile"
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
                  {!consentRequired && (
                    <>
                      <Button kind="ghost" size="sm" onClick={() => navigate('/profile')}>
                        View profile
                      </Button>
                      <Button kind="ghost" size="sm" onClick={() => navigate('/profile/notifications')}>
                        My notifications
                      </Button>
                      <Button
                        kind="ghost"
                        size="sm"
                        renderIcon={Calendar}
                        onClick={() => {
                          setProfilePanelOpen(false);
                          setCalendarDialogOpen(true);
                        }}
                      >
                        Calendar subscription
                      </Button>
                    </>
                  )}
                  <Button kind="ghost" size="sm" onClick={() => setColorScheme(dark ? 'light' : 'dark')}>
                    {dark ? 'Use light theme' : 'Use dark theme'}
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
              {!consentRequired && (
                <SideNav
                  aria-label="Primary navigation"
                  data-guide="shell-nav"
                  expanded={sideNavExpanded}
                  isFixedNav
                  isPersistent={false}
                  onOverlayClick={() => setSideNavExpanded(false)}
                >
                  <AppNavigation currentUser={currentUser} legal={branding.legal} onNavigate={handleNavigation} />
                </SideNav>
              )}
            </Header>
          </Theme>

          <main
            id="main-content"
            tabIndex={-1}
            className={`app-main${sideNavExpanded && !isNarrow && !consentRequired ? ' app-main--nav-expanded' : ''}`}
          >
            <DemoBanner />
            <NotificationAlertHost />
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
            <Suspense fallback={<FullPageLoading label="Loading page" />}>
              {consentRequired ? <ConsentGate /> : <Outlet />}
            </Suspense>
          </main>
          {consentRequired ? null : showLabRulesModal ? (
            <Suspense fallback={null}>
              <LabRulesConfirmModal status={labRules} onLater={() => setLabRulesDeferred(true)} />
            </Suspense>
          ) : (
            <Suspense fallback={null}>
              <GuideOffer />
            </Suspense>
          )}
          {(calendarDialogOpen || calendarLinked) && (
            <Suspense fallback={null}>
              <CalendarSubscriptionDialog onClose={closeCalendarDialog} />
            </Suspense>
          )}
        </div>
      </GuideProvider>
    </ToastProvider>
  );
}
