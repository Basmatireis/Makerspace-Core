import { useEffect, useRef, type ReactNode } from 'react';
import { SideNavDivider, SideNavItems, SideNavLink, SideNavMenu, SideNavMenuItem } from '@carbon/react';
import {
  Calendar,
  Dashboard,
  DocumentSecurity,
  Information,
  Policy,
  Receipt,
  Screen,
  Settings,
  Tools,
  UserMultiple,
} from '@carbon/icons-react';
import type { CurrentUser, PublicLegalLinks } from '../api/generated/models';
import { Link, useLocation } from 'react-router-dom';
import { canAccessOpenDays, canAccessSettings, hasAnyPermission, hasPermission } from '../features/auth/permissions';

type NavigationGroupId = 'operations' | 'people' | 'machines' | 'sales' | 'signage';

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

function NavigationGroup({ title, icon, items, active, pathname, onNavigate }: NavigationGroupProps) {
  const menuButtonRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (active && menuButtonRef.current?.getAttribute('aria-expanded') === 'false') {
      menuButtonRef.current.click();
    }
  }, [active, pathname]);

  if (items.length === 0) return null;

  return (
    <SideNavMenu ref={menuButtonRef} title={title} defaultExpanded={active} isActive={active} renderIcon={icon}>
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
  if (pathname.startsWith('/open-days') || pathname.startsWith('/events') || pathname.startsWith('/attendance'))
    return 'operations';
  if (pathname.startsWith('/people') || pathname.startsWith('/organizations') || pathname.startsWith('/notifications'))
    return 'people';
  if (pathname.startsWith('/machine-logbook')) return 'machines';
  if (
    pathname === '/sales' ||
    pathname.startsWith('/orders') ||
    pathname.startsWith('/payments') ||
    pathname.startsWith('/pricing') ||
    pathname.startsWith('/external-invoicing')
  )
    return 'sales';
  if (pathname.startsWith('/signage')) return 'signage';
  return null;
}

export function AppNavigation({ currentUser, legal, onNavigate }: AppNavigationProps) {
  const { pathname } = useLocation();
  const activeGroup = activeGroupForPath(pathname);

  const operations: NavigationItem[] = [];
  if (canAccessOpenDays(currentUser)) {
    operations.push({ label: 'Open Days', to: '/open-days', active: pathname.startsWith('/open-days') });
  }
  if (hasAnyPermission(currentUser, ['events.read', 'events.manage', 'events.staffing.manage', 'events.assign'])) {
    operations.push({
      label: 'Events',
      to: '/events',
      active: pathname === '/events' || pathname.startsWith('/events/'),
    });
  }
  if (hasAnyPermission(currentUser, ['attendance.read', 'attendance.assist', 'attendance.statistics.read'])) {
    operations.push({ label: 'Attendance', to: '/attendance', active: pathname.startsWith('/attendance') });
  }

  const people: NavigationItem[] = [];
  if (hasPermission(currentUser, 'people.read.all')) {
    people.push({
      label: 'People',
      to: '/people',
      active: pathname === '/people' || (pathname.startsWith('/people/') && !pathname.startsWith('/people/staffing')),
    });
  }
  if (hasPermission(currentUser, 'organizations.read')) {
    people.push({ label: 'Organizations', to: '/organizations', active: pathname.startsWith('/organizations') });
  }
  if (hasPermission(currentUser, 'supervisor_dashboard.read')) {
    people.push({ label: 'Staffing', to: '/people/staffing', active: pathname.startsWith('/people/staffing') });
  }

  if (hasPermission(currentUser, 'notifications.send')) {
    people.push({
      label: 'Messages',
      to: '/notifications/messages',
      active: pathname.startsWith('/notifications'),
    });
  }

  const machines: NavigationItem[] = [];
  if (hasAnyPermission(currentUser, ['machine_jobs.read', 'statistics.read'])) {
    machines.push({ label: 'Overview', to: '/machine-logbook', active: pathname === '/machine-logbook' });
  }
  if (hasPermission(currentUser, 'machine_jobs.read')) {
    machines.push({ label: 'Jobs', to: '/machine-logbook/jobs', active: pathname.startsWith('/machine-logbook/jobs') });
  }
  if (hasPermission(currentUser, 'machines.read')) {
    machines.push({
      label: 'Machines',
      to: '/machine-logbook/machines',
      active: pathname.startsWith('/machine-logbook/machines'),
    });
  }
  if (hasPermission(currentUser, 'inventory.read')) {
    machines.push({
      label: 'Inventory',
      to: '/machine-logbook/inventory',
      active: pathname.startsWith('/machine-logbook/inventory'),
    });
  }
  if (hasPermission(currentUser, 'statistics.read')) {
    machines.push({
      label: 'Statistics',
      to: '/machine-logbook/statistics',
      active: pathname.startsWith('/machine-logbook/statistics'),
    });
  }

  const sales: NavigationItem[] = [];
  if (hasAnyPermission(currentUser, ['orders.read', 'payments.read'])) {
    sales.push({ label: 'Overview', to: '/sales', active: pathname === '/sales' });
  }
  if (hasPermission(currentUser, 'orders.read')) {
    sales.push({ label: 'Orders', to: '/orders', active: pathname.startsWith('/orders') });
  }
  if (hasPermission(currentUser, 'payments.read')) {
    sales.push({ label: 'Payments', to: '/payments', active: pathname.startsWith('/payments') });
  }
  if (hasPermission(currentUser, 'pricing.read')) {
    sales.push({ label: 'Pricing', to: '/pricing', active: pathname.startsWith('/pricing') });
  }

  const signage: NavigationItem[] = [];
  const canReadSignage = hasPermission(currentUser, 'signage.read');
  if (canReadSignage) {
    signage.push({
      label: 'Displays',
      to: '/signage',
      active: pathname === '/signage' || pathname.startsWith('/signage/displays'),
    });
  }
  if (canReadSignage || hasPermission(currentUser, 'signage.override')) {
    signage.push({
      label: 'Announcements',
      to: '/signage/announcements',
      active: pathname.startsWith('/signage/announcements'),
    });
  }
  if (canReadSignage) {
    signage.push({
      label: 'Content',
      to: '/signage/content',
      active:
        pathname.startsWith('/signage/content') ||
        pathname.startsWith('/signage/scenes') ||
        pathname.startsWith('/signage/layouts') ||
        pathname.startsWith('/signage/playlists'),
    });
    signage.push({ label: 'Media', to: '/signage/media', active: pathname.startsWith('/signage/media') });
  }

  const canReadAuditLog = hasPermission(currentUser, 'audit.read');
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
        {renderGroup('machines', 'Workshop', Tools, machines)}
        {renderGroup('sales', 'Sales & payments', Receipt, sales)}
        {renderGroup('operations', 'Operations', Calendar, operations)}
        {renderGroup('signage', 'Signage', Screen, signage)}
        {renderGroup('people', 'Directory', UserMultiple, people)}
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
        <SideNavLink
          as={Link}
          to="/about"
          isActive={pathname === '/about'}
          renderIcon={Information}
          onClick={onNavigate}
        >
          About
        </SideNavLink>
        {legal.imprint.mode === 'external' ? (
          <SideNavLink href={legal.imprint.href} renderIcon={Policy}>
            Imprint
          </SideNavLink>
        ) : (
          <SideNavLink
            as={Link}
            to={legal.imprint.href}
            isActive={pathname === '/legal/imprint'}
            renderIcon={Policy}
            onClick={onNavigate}
          >
            Imprint
          </SideNavLink>
        )}
        {legal.privacy.mode === 'external' ? (
          <SideNavLink href={legal.privacy.href} renderIcon={DocumentSecurity}>
            Privacy policy
          </SideNavLink>
        ) : (
          <SideNavLink
            as={Link}
            to={legal.privacy.href}
            isActive={pathname === '/legal/privacy'}
            renderIcon={DocumentSecurity}
            onClick={onNavigate}
          >
            Privacy policy
          </SideNavLink>
        )}
      </SideNavItems>
    </>
  );
}
