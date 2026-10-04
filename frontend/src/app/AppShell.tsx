import { Suspense, useEffect, useMemo, useRef, useState } from 'react';
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
  SideNavDivider,
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
  Dashboard,
  DocumentSecurity,
  Calendar,
  Information,
  Logout,
  Policy,
  Settings,
  Tools,
  UserAvatar,
  UserMultiple,
} from '@carbon/icons-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { getGetLaborordnungPDFUrl, requestOwnLaborordnungConfirmation } from '../api/generated/laborordnung/laborordnung';
import { evaluateVisitorAdmission } from '../api/generated/visitor-enrollment/visitor-enrollment';
import { authQueryKey, useCurrentUser, useLogout } from '../features/auth/auth';
import { canAccessMachineLogbook, canAccessOpenDays, canAccessSettings, hasPermission, PermissionId } from '../features/auth/permissions';
import { PersonAvatar } from '../features/users/PersonAvatar';
import { BrandMark } from './BrandMark';
import { FullPageLoading } from './PageState';
import { useBranding } from '../features/branding/branding';

const NARROW_SHELL_QUERY = '(max-width: 65.98rem)';

function currentNarrowState(): boolean {
  return typeof window.matchMedia === 'function'
    ? window.matchMedia(NARROW_SHELL_QUERY).matches
    : false;
}

export function AppShell() {
  const currentUser = useCurrentUser();
	const branding = useBranding();
	const queryClient = useQueryClient();
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
	const labRulesRequest = useMutation({
		mutationFn: () => requestOwnLaborordnungConfirmation(),
		onSuccess: async () => queryClient.invalidateQueries({ queryKey: authQueryKey }),
	});
	const admissionRequest = useMutation({
		mutationFn: () => evaluateVisitorAdmission(),
		onSuccess: async () => queryClient.invalidateQueries({ queryKey: authQueryKey }),
	});
	const useAdmissionAction = currentUser.laborordnungStatus.mode === 'blocking' && Boolean(currentUser.managedDevice);

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
  const machineLogbookActive = location.pathname.startsWith('/machine-logbook');
  const peopleActive = location.pathname.startsWith('/people');
  const canAccessPeopleDirectory = hasPermission(currentUser, PermissionId.peoplereadall);
  const canAccessSupervisorStaffing = hasPermission(currentUser, PermissionId.supervisor_dashboardread);
  const canAccessPeople = canAccessPeopleDirectory || canAccessSupervisorStaffing;
  const canReadAuditLog = hasPermission(currentUser, PermissionId.auditread);
  const showAdministration = canAccessSettings(currentUser) || canReadAuditLog;

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
          <HeaderName
            as={Link}
            to="/dashboard"
            prefix=""
            className="app-header__brand"
          >
            <BrandMark kind="compact" className="app-header__logo" />
            <span className="app-header__wordmark">
              <span>{branding.identity.legalOrganizationName}</span>
              <strong>{branding.identity.displayName}</strong>
            </span>
          </HeaderName>
          <HeaderGlobalBar>
            <span className="header-account__name">{displayName}</span>
            <HeaderGlobalAction
            aria-label={`${profilePanelOpen ? 'Close' : 'Open'} profile menu for ${displayName}`}
            tooltipAlignment="end"
            isActive={profilePanelOpen}
            ref={profileActionRef}
            onClick={() => setProfilePanelOpen((open) => !open)}
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
                {(currentUser.person.email || currentUser.person.phone) && (
                  <p className="profile-panel__email">
                    {currentUser.person.email ?? currentUser.person.phone}
                  </p>
                )}
              </div>
              <Tag type={currentUser.account.status === 'enabled' ? 'green' : 'gray'}>
                {currentUser.account.status === 'enabled' ? 'Active' : 'Inactive'}
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
            <SideNavItems className="app-side-nav__primary">
              <SideNavLink
                as={Link}
                to="/dashboard"
                isActive={location.pathname === '/dashboard'}
                renderIcon={Dashboard}
              >
                Dashboard
              </SideNavLink>
              {canAccessOpenDays(currentUser) && (
                <SideNavLink
                  as={Link}
                  to="/open-days"
                  isActive={location.pathname.startsWith('/open-days')}
                  renderIcon={Calendar}
                >
                  Open Days
                </SideNavLink>
              )}
              {canAccessMachineLogbook(currentUser) && <SideNavMenu title="Machines" defaultExpanded={machineLogbookActive} isActive={machineLogbookActive} renderIcon={Tools}>
                {(hasPermission(currentUser, PermissionId.machine_jobsread) || hasPermission(currentUser, PermissionId.statisticsread)) && <SideNavMenuItem as={Link} to="/machine-logbook" isActive={location.pathname === '/machine-logbook'}>Overview</SideNavMenuItem>}
                {hasPermission(currentUser, PermissionId.machine_jobsread) && <SideNavMenuItem as={Link} to="/machine-logbook/jobs" isActive={location.pathname.startsWith('/machine-logbook/jobs')}>Jobs</SideNavMenuItem>}
                {hasPermission(currentUser, PermissionId.machine_jobsreview) && <SideNavMenuItem as={Link} to="/machine-logbook/review" isActive={location.pathname.startsWith('/machine-logbook/review')}>Review</SideNavMenuItem>}
                {hasPermission(currentUser, PermissionId.inventoryread) && <SideNavMenuItem as={Link} to="/machine-logbook/inventory" isActive={location.pathname.startsWith('/machine-logbook/inventory')}>Inventory</SideNavMenuItem>}
                {hasPermission(currentUser, PermissionId.machinesread) && <SideNavMenuItem as={Link} to="/machine-logbook/machines" isActive={location.pathname.startsWith('/machine-logbook/machines')}>Machines</SideNavMenuItem>}
                {hasPermission(currentUser, PermissionId.statisticsread) && <SideNavMenuItem as={Link} to="/machine-logbook/statistics" isActive={location.pathname.startsWith('/machine-logbook/statistics')}>Statistics</SideNavMenuItem>}
              </SideNavMenu>}
              {canAccessPeople && (
                <SideNavLink
                  as={Link}
                  to={canAccessPeopleDirectory ? '/people' : '/people/staffing'}
                  isActive={peopleActive}
                  renderIcon={UserMultiple}
                >
                  People
                </SideNavLink>
              )}
              {showAdministration && (
                <>
                  <SideNavDivider />
                  <li className="app-side-nav__heading">Administration</li>
                  {canAccessSettings(currentUser) && <SideNavLink
                    as={Link}
                    to="/settings"
                    isActive={settingsActive}
                    renderIcon={Settings}
                  >
                    Settings
                  </SideNavLink>}
                  {canReadAuditLog && <SideNavLink
                    as={Link}
                    to="/audit-log"
                    isActive={location.pathname === '/audit-log'}
                    renderIcon={DocumentSecurity}
                  >
                    Audit Log
                  </SideNavLink>}
                </>
              )}
            </SideNavItems>
            <SideNavItems className="app-side-nav__secondary">
              <SideNavLink as={Link} to="/about" isActive={location.pathname === '/about'} renderIcon={Information}>
                About
              </SideNavLink>
              {branding.legal.imprint.mode === 'external' ? <SideNavLink href={branding.legal.imprint.href} renderIcon={Policy}>Imprint</SideNavLink> : <SideNavLink as={Link} to={branding.legal.imprint.href} isActive={location.pathname === '/legal/imprint'} renderIcon={Policy}>Imprint</SideNavLink>}
              {branding.legal.privacy.mode === 'external' ? <SideNavLink href={branding.legal.privacy.href} renderIcon={DocumentSecurity}>Privacy policy</SideNavLink> : <SideNavLink as={Link} to={branding.legal.privacy.href} isActive={location.pathname === '/legal/privacy'} renderIcon={DocumentSecurity}>Privacy policy</SideNavLink>}
            </SideNavItems>
          </SideNav>
        </Header>
      </Theme>

      <main
        id="main-content"
        tabIndex={-1}
        className={`app-main${sideNavExpanded && !isNarrow ? ' app-main--nav-expanded' : ''}`}
      >
		{currentUser.laborordnungStatus.actionRequired && currentUser.laborordnungStatus.currentVersion && (
			<section className="lab-rules-warning" aria-label="Lab Rules action required">
				<InlineNotification
					kind="warning"
					lowContrast
					hideCloseButton
					title={currentUser.laborordnungStatus.mode === 'blocking' ? 'Current Lab Rules required for admission' : 'Your Lab Rules confirmation is outdated'}
					subtitle={`Review revision ${currentUser.laborordnungStatus.currentVersion.humanRevision}. Normal application access remains available${currentUser.laborordnungStatus.mode === 'warning' ? '' : ', but admission remains blocked until physical confirmation'}.`}
				/>
				<div className="button-cluster">
					<Button kind="tertiary" size="sm" href={getGetLaborordnungPDFUrl(currentUser.laborordnungStatus.currentVersion.id)} target="_blank">View current Lab Rules PDF</Button>
					<Button kind="primary" size="sm" disabled={Boolean(currentUser.laborordnungStatus.requestId) || labRulesRequest.isPending || admissionRequest.isPending} onClick={() => useAdmissionAction ? admissionRequest.mutate() : labRulesRequest.mutate()}>
						{currentUser.laborordnungStatus.requestId ? 'Signature confirmation requested' : labRulesRequest.isPending || admissionRequest.isPending ? 'Requesting…' : useAdmissionAction ? 'Request admission' : 'Request signature confirmation'}
					</Button>
				</div>
				{labRulesRequest.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Request not created" subtitle="Try again or contact a supervisor." />}
				{admissionRequest.isError && <InlineNotification kind="error" lowContrast hideCloseButton title="Admission not evaluated" subtitle="This action requires an approved visitor terminal." />}
			</section>
		)}
        <Suspense fallback={<FullPageLoading label="Loading page" />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
