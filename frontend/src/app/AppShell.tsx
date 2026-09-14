import { useEffect, useMemo, useRef, useState } from 'react';
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
  SideNavItems,
  SideNavLink,
  SideNavMenu,
  SideNavMenuItem,
  SkipToContent,
  Stack,
  Tag,
  Theme,
} from '@carbon/react';
import {
  Dashboard as DashboardIcon,
  Calendar,
  Logout,
  Settings as SettingsIcon,
  UserAvatar,
} from '@carbon/icons-react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useCurrentUser, useLogout } from '../features/auth/auth';
import { canAccessOpenDays, canAccessSettings } from '../features/auth/permissions';

const NARROW_SHELL_QUERY = '(max-width: 65.98rem)';

function currentNarrowState(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(NARROW_SHELL_QUERY).matches
    : false;
}

export function AppShell() {
  const currentUser = useCurrentUser();
  const logoutMutation = useLogout();
  const location = useLocation();
  const navigate = useNavigate();
  const [isNarrow, setIsNarrow] = useState(currentNarrowState);
  const [sideNavExpanded, setSideNavExpanded] = useState(
    () => !currentNarrowState(),
  );
  const [profilePanelOpen, setProfilePanelOpen] = useState(false);
  const profileActionRef = useRef<HTMLButtonElement>(null);
  const profilePanelRef = useRef<HTMLDivElement>(null);

  const displayName = useMemo(
    () => `${currentUser.person.firstName} ${currentUser.person.lastName}`,
    [currentUser.person.firstName, currentUser.person.lastName],
  );

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
    if (isNarrow) {
      setSideNavExpanded(false);
    }
  }, [isNarrow, location.pathname]);

  const settingsActive = location.pathname.startsWith('/settings');

  return (
    <div className="app-shell">
      <Theme theme="g100">
        <Header aria-label="HTU Graz Makerspace">
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
          <HeaderName as={Link} to="/dashboard" prefix="HTU Graz">
            Makerspace
          </HeaderName>
          <HeaderGlobalBar>
            <HeaderGlobalAction
            aria-label={`${profilePanelOpen ? 'Close' : 'Open'} profile menu for ${displayName}`}
            tooltipAlignment="end"
            isActive={profilePanelOpen}
            ref={profileActionRef}
            onClick={() => setProfilePanelOpen((open) => !open)}
            >
              <UserAvatar size={20} />
            </HeaderGlobalAction>
          </HeaderGlobalBar>
          <HeaderPanel
            expanded={profilePanelOpen}
            className="profile-panel"
            ref={profilePanelRef}
            onHeaderPanelFocus={() => {
              const restoreFocus = profilePanelRef.current?.contains(
                document.activeElement,
              );
              setProfilePanelOpen(false);
              if (restoreFocus) {
                profileActionRef.current?.focus();
              }
            }}
          >
            <Stack gap={5} className="profile-panel__content">
              <div>
                <p className="profile-panel__name">{displayName}</p>
                <p className="profile-panel__email">
                  {currentUser.account.loginEmail}
                </p>
              </div>
              <Tag type={currentUser.account.status === 'enabled' ? 'green' : 'gray'}>
                {currentUser.account.status === 'enabled' ? 'Enabled' : 'Disabled'}
              </Tag>
              <Button
                kind="ghost"
                size="sm"
                onClick={() => navigate('/profile')}
              >
                View profile
              </Button>
              <Button
                kind="ghost"
                size="sm"
                renderIcon={Logout}
                disabled={logoutMutation.isPending}
                onClick={() => logoutMutation.mutate()}
              >
                {logoutMutation.isPending ? 'Signing out…' : 'Sign out'}
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
            <SideNavItems>
              <SideNavLink
                as={Link}
                to="/dashboard"
                renderIcon={DashboardIcon}
                isActive={location.pathname === '/dashboard'}
              >
                Dashboard
              </SideNavLink>
              {canAccessOpenDays(currentUser) && (
                <SideNavLink
                  as={Link}
                  to="/open-days"
                  renderIcon={Calendar}
                  isActive={location.pathname.startsWith('/open-days')}
                >
                  Open Days
                </SideNavLink>
              )}
              {canAccessSettings(currentUser) && (
                <SideNavMenu
                  title="Administration"
                  renderIcon={SettingsIcon}
                  defaultExpanded={settingsActive}
                  isActive={settingsActive}
                >
                  <SideNavMenuItem
                    as={Link}
                    to="/settings"
                    isActive={settingsActive}
                  >
                    Settings
                  </SideNavMenuItem>
                </SideNavMenu>
              )}
            </SideNavItems>
          </SideNav>
        </Header>
      </Theme>

      <main
        id="main-content"
        tabIndex={-1}
        className={`app-main${sideNavExpanded && !isNarrow ? ' app-main--nav-expanded' : ''}`}
      >
        <Outlet />
      </main>
    </div>
  );
}
