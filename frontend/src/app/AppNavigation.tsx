import { useEffect, useRef, type ReactNode } from 'react';
import {
  SideNavDivider,
  SideNavItems,
  SideNavLink,
  SideNavMenu,
  SideNavMenuItem,
} from '@carbon/react';
import {
  Calendar,
  Dashboard,
  DocumentSecurity,
  Information,
  Policy,
  Receipt,
  Settings,
  Tools,
  UserMultiple,
} from '@carbon/icons-react';
import type { CurrentUser, PublicLegalLinks } from '../api/generated/models';
import { Link, useLocation } from 'react-router-dom';
import {
  canAccessOpenDays,
  canAccessSettings,
  hasAnyPermission,
  hasPermission,
  PermissionId,
} from '../features/auth/permissions';

type NavigationGroupId = 'operations' | 'people' | 'machines' | 'sales';

interface NavigationItem {
  label: string;
  to: string;
  active: boolean;
}

interface NavigationGroupProps {
  title: string;
  icon: typeof Calendar;
  items: NavigationItem[];
  active: boolean;
  pathname: string;
  onNavigate: () => void;
}

export interface AppNavigationProps {
  currentUser: CurrentUser;
  legal: PublicLegalLinks;
  onNavigate: () => void;
}

function NavigationGroup({
  title,
  icon,
  items,
  active,
  pathname,
  onNavigate,
}: NavigationGroupProps) {
  const menuButtonRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (active && menuButtonRef.current?.getAttribute('aria-expanded') === 'false') {
      menuButtonRef.current.click();
    }
  }, [active, pathname]);

  if (items.length === 0) return null;

  return (
    <SideNavMenu
      ref={menuButtonRef}
      title={title}
      defaultExpanded={active}
      isActive={active}
      renderIcon={icon}
    >
      {items.map((item) => (
        <SideNavMenuItem
          key={item.to}
          as={Link}
          to={item.to}
          isActive={item.active}
          aria-current={item.active ? 'page' : undefined}
          onClick={onNavigate}
        >
          {item.label}
        </SideNavMenuItem>
      ))}
    </SideNavMenu>
  );
}

function activeGroupForPath(pathname: string): NavigationGroupId | null {
  if (pathname.startsWith('/open-days') || pathname.startsWith('/events') || pathname.startsWith('/attendance')) return 'operations';
  if (pathname.startsWith('/people')) return 'people';
  if (pathname.startsWith('/machine-logbook')) return 'machines';
  if (pathname.startsWith('/orders') || pathname.startsWith('/payments') || pathname.startsWith('/external-invoicing')) return 'sales';
  return null;
}

export function AppNavigation({ currentUser, legal, onNavigate }: AppNavigationProps) {
  const { pathname } = useLocation();
  const activeGroup = activeGroupForPath(pathname);

  const operations: NavigationItem[] = [];
  if (canAccessOpenDays(currentUser)) {
    operations.push({ label: 'Open Days', to: '/open-days', active: pathname.startsWith('/open-days') });
  }
  if (hasAnyPermission(currentUser, [PermissionId.eventsread, PermissionId.eventsmanage, PermissionId.eventsstaffingmanage, PermissionId.eventsassign])) {
    operations.push({ label: 'Events', to: '/events', active: pathname === '/events' || pathname.startsWith('/events/') });
  }
  if (hasAnyPermission(currentUser, [PermissionId.attendanceread, PermissionId.attendanceassist, PermissionId.attendancestatisticsread])) {
    operations.push({ label: 'Attendance', to: '/attendance', active: pathname.startsWith('/attendance') });
  }

  const people: NavigationItem[] = [];
  if (hasPermission(currentUser, PermissionId.peoplereadall)) {
    people.push({ label: 'Directory', to: '/people', active: pathname === '/people' || (pathname.startsWith('/people/') && !pathname.startsWith('/people/staffing')) });
  }
  if (hasPermission(currentUser, PermissionId.supervisor_dashboardread)) {
    people.push({ label: 'Staffing', to: '/people/staffing', active: pathname.startsWith('/people/staffing') });
  }

  const machines: NavigationItem[] = [];
  if (hasAnyPermission(currentUser, [PermissionId.machine_jobsread, PermissionId.statisticsread])) {
    machines.push({ label: 'Overview', to: '/machine-logbook', active: pathname === '/machine-logbook' });
  }
  if (hasPermission(currentUser, PermissionId.machinesread)) {
    machines.push({ label: 'Machines', to: '/machine-logbook/machines', active: pathname.startsWith('/machine-logbook/machines') });
  }
  if (hasPermission(currentUser, PermissionId.machine_jobsread)) {
    machines.push({ label: 'Jobs', to: '/machine-logbook/jobs', active: pathname.startsWith('/machine-logbook/jobs') });
  }
  if (hasPermission(currentUser, PermissionId.machine_jobsreview)) {
    machines.push({ label: 'Review', to: '/machine-logbook/review', active: pathname.startsWith('/machine-logbook/review') });
  }
  if (hasPermission(currentUser, PermissionId.print_submissionsread)) {
    machines.push({ label: 'Print submissions', to: '/machine-logbook/print-submissions', active: pathname.startsWith('/machine-logbook/print-submissions') });
  }
  if (hasPermission(currentUser, PermissionId.inventoryread)) {
    machines.push({ label: 'Inventory', to: '/machine-logbook/inventory', active: pathname.startsWith('/machine-logbook/inventory') || pathname.startsWith('/machine-logbook/spools') });
  }
  if (hasPermission(currentUser, PermissionId.statisticsread)) {
    machines.push({ label: 'Statistics', to: '/machine-logbook/statistics', active: pathname.startsWith('/machine-logbook/statistics') });
  }

  const sales: NavigationItem[] = [];
  if (hasPermission(currentUser, PermissionId.ordersread)) {
    sales.push({ label: 'Orders', to: '/orders', active: pathname.startsWith('/orders') });
  }
  if (hasPermission(currentUser, PermissionId.paymentsread)) {
    sales.push({ label: 'Payments', to: '/payments', active: pathname.startsWith('/payments') });
  }
  if (hasPermission(currentUser, PermissionId.external_invoice_requestsread)) {
    sales.push({ label: 'External invoicing', to: '/external-invoicing', active: pathname.startsWith('/external-invoicing') });
  }

  const canReadAuditLog = hasPermission(currentUser, PermissionId.auditread);
  const showAdministration = canAccessSettings(currentUser) || canReadAuditLog;

  const renderGroup = (
    id: NavigationGroupId,
    title: string,
    icon: typeof Calendar,
    items: NavigationItem[],
  ): ReactNode => (
    <NavigationGroup
      title={title}
      icon={icon}
      items={items}
      active={activeGroup === id}
      pathname={pathname}
      onNavigate={onNavigate}
    />
  );

  return (
    <>
      <SideNavItems className="app-side-nav__primary">
        <SideNavLink
          as={Link}
          to="/dashboard"
          isActive={pathname === '/dashboard'}
          aria-current={pathname === '/dashboard' ? 'page' : undefined}
          renderIcon={Dashboard}
          onClick={onNavigate}
        >
          Dashboard
        </SideNavLink>
        {renderGroup('operations', 'Operations', Calendar, operations)}
        {renderGroup('people', 'People', UserMultiple, people)}
        {renderGroup('machines', 'Workshop', Tools, machines)}
        {renderGroup('sales', 'Sales & payments', Receipt, sales)}
        {showAdministration && (
          <>
            <SideNavDivider />
            <li className="app-side-nav__heading">Administration</li>
            {canAccessSettings(currentUser) && (
              <SideNavLink
                as={Link}
                to="/settings"
                isActive={pathname.startsWith('/settings')}
                aria-current={pathname.startsWith('/settings') ? 'page' : undefined}
                renderIcon={Settings}
                onClick={onNavigate}
              >
                Settings
              </SideNavLink>
            )}
            {canReadAuditLog && (
              <SideNavLink
                as={Link}
                to="/audit-log"
                isActive={pathname === '/audit-log'}
                aria-current={pathname === '/audit-log' ? 'page' : undefined}
                renderIcon={DocumentSecurity}
                onClick={onNavigate}
              >
                Audit Log
              </SideNavLink>
            )}
          </>
        )}
      </SideNavItems>
      <SideNavItems className="app-side-nav__secondary">
        <SideNavLink as={Link} to="/about" isActive={pathname === '/about'} renderIcon={Information} onClick={onNavigate}>
          About
        </SideNavLink>
        {legal.imprint.mode === 'external'
          ? <SideNavLink href={legal.imprint.href} renderIcon={Policy}>Imprint</SideNavLink>
          : <SideNavLink as={Link} to={legal.imprint.href} isActive={pathname === '/legal/imprint'} renderIcon={Policy} onClick={onNavigate}>Imprint</SideNavLink>}
        {legal.privacy.mode === 'external'
          ? <SideNavLink href={legal.privacy.href} renderIcon={DocumentSecurity}>Privacy policy</SideNavLink>
          : <SideNavLink as={Link} to={legal.privacy.href} isActive={pathname === '/legal/privacy'} renderIcon={DocumentSecurity} onClick={onNavigate}>Privacy policy</SideNavLink>}
      </SideNavItems>
    </>
  );
}
