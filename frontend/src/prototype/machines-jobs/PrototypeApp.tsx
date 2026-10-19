import { Fragment, useEffect, useState } from 'react';
import {
  ActionableNotification, Button, Header, HeaderGlobalAction, HeaderGlobalBar, HeaderMenuButton, HeaderName, HeaderPanel, RadioButton, RadioButtonGroup,
  Select, SelectItem, SideNav, SideNavItems, SideNavLink, SkipToContent, Stack, Tag, Theme, ToastNotification,
} from '@carbon/react';
import { Chemistry, Dashboard, Reset, Tools, Catalog, InventoryManagement, ChartColumn, Currency, Receipt, Wallet, Tag as TagIcon, Screen, Image as ImageIcon, Document, Settings } from '@carbon/icons-react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate, useParams } from 'react-router-dom';
import { rolePresets, useStore, type ConnectionTestMode, type Permission, type Role, type Scenario, type Toast } from './store';
import { OverviewPage } from './pages/OverviewPage';
import { PrintDetailPage } from './pages/PrintDetailPage';
import { JobsPage } from './pages/JobsPage';
import { JobDetailPage } from './pages/JobDetailPage';
import { MachinesPage } from './pages/MachinesPage';
import { MachineDetailPage } from './pages/MachineDetailPage';
import { InventoryPage } from './pages/InventoryPage';
import { MaterialDetailPage } from './pages/MaterialDetailPage';
import { SpoolDetailPage } from './pages/SpoolDetailPage';
import { StatisticsPage } from './pages/StatisticsPage';
import { SalesOverviewPage } from './sales/pages/SalesOverviewPage';
import { OrdersPage } from './sales/pages/OrdersPage';
import { OrderDetailPage } from './sales/pages/OrderDetailPage';
import { ReceiptPage } from './sales/pages/ReceiptPage';
import { PaymentsPage } from './sales/pages/PaymentsPage';
import { PaymentDetailPage } from './sales/pages/PaymentDetailPage';
import { PricingPage } from './sales/pages/PricingPage';
import { ContentPage } from './signage/pages/ContentPage';
import { DisplayDetailPage } from './signage/pages/DisplayDetailPage';
import { DisplaysPage } from './signage/pages/DisplaysPage';
import { LocalServicesPage } from './signage/pages/LocalServicesPage';
import { MediaPage } from './signage/pages/MediaPage';
import { PlayerPage } from './signage/pages/PlayerPage';
import { PlaylistDetailPage } from './signage/pages/PlaylistDetailPage';
import { SceneEditorPage } from './signage/pages/SceneEditorPage';
import { SignageSimulationControls } from './signage/components/SignageSimulationControls';

type NavItem = { label: string; to: string; icon: typeof Dashboard; match: (path: string) => boolean };

const NAV: NavItem[] = [
  { label: 'Overview', to: '/', icon: Dashboard, match: (p) => p === '/' },
  { label: 'Jobs', to: '/jobs', icon: Catalog, match: (p) => p.startsWith('/jobs') },
  { label: 'Machines', to: '/machines', icon: Tools, match: (p) => p.startsWith('/machines') },
  { label: 'Inventory', to: '/inventory', icon: InventoryManagement, match: (p) => p.startsWith('/inventory') },
  { label: 'Statistics', to: '/statistics', icon: ChartColumn, match: (p) => p.startsWith('/statistics') },
];

type SalesNavItem = NavItem & { /** Shown when the role holds at least one of these permissions (all of them for an array inside an array). */ needs: Permission[][] };

const SALES_NAV: SalesNavItem[] = [
  { label: 'Overview', to: '/sales', icon: Currency, match: (p) => p === '/sales', needs: [['payments.read']] },
  { label: 'Orders', to: '/sales/orders', icon: Receipt, match: (p) => p.startsWith('/sales/orders'), needs: [['orders.read']] },
  { label: 'Payments', to: '/sales/payments', icon: Wallet, match: (p) => p.startsWith('/sales/payments'), needs: [['payments.read']] },
  { label: 'Pricing', to: '/sales/pricing', icon: TagIcon, match: (p) => p.startsWith('/sales/pricing'), needs: [['pricing.read']] },
];

const SIGNAGE_NAV: SalesNavItem[] = [
  { label: 'Displays', to: '/signage', icon: Screen, match: (p) => p === '/signage' || p.startsWith('/signage/displays'), needs: [['signage.read']] },
  { label: 'Content', to: '/signage/content', icon: Document, match: (p) => p.startsWith('/signage/content') || p.startsWith('/signage/scenes') || p.startsWith('/signage/playlists'), needs: [['signage.read']] },
  { label: 'Media', to: '/signage/media', icon: ImageIcon, match: (p) => p.startsWith('/signage/media'), needs: [['signage.read']] },
];

const SETTINGS_NAV: SalesNavItem[] = [
  { label: 'Local services', to: '/settings/local-services', icon: Settings, match: (p) => p.startsWith('/settings/local-services'), needs: [['local_services.manage']] },
];

/** Old bookmarks used "prints" for what the UI now calls runs. */
function LegacyRunRedirect() {
  const { printId = '' } = useParams();
  return <Navigate to={`/jobs/runs/${printId}`} replace />;
}

/** Toast with a follow-up link. Carbon's toast may not contain links, so this uses the actionable notification and dismisses itself. */
function ActionToast({ toast }: { toast: Toast }) {
  const store = useStore();
  const navigate = useNavigate();
  useEffect(() => {
    const timer = window.setTimeout(() => store.dismissToast(toast.id), 9000);
    return () => window.clearTimeout(timer);
  }, [toast.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <ActionableNotification
      kind={toast.kind} lowContrast title={toast.title} subtitle={toast.subtitle} actionButtonLabel={toast.action!.label}
      onActionButtonClick={() => { navigate(toast.action!.to); store.dismissToast(toast.id); }} onCloseButtonClick={() => store.dismissToast(toast.id)}
    />
  );
}

function useIsNarrow() {
  const query = '(max-width: 65.98rem)';
  const [narrow, setNarrow] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const onChange = () => setNarrow(media.matches);
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return narrow;
}

function PrototypeControls() {
  const store = useStore();
  return (
    <Stack gap={6} className="prototype-controls">
      <div>
        <p className="prototype-controls__title">Prototype controls</p>
        <p className="prototype-controls__hint">Frontend-only mockup with local data. Nothing is sent to the API.</p>
      </div>
      <RadioButtonGroup legendText="View as" name="prototype-role" orientation="vertical" valueSelected={store.role} onChange={(value) => store.setRole(value as Role)}>
        {(Object.keys(rolePresets) as Role[]).map((role) => <RadioButton key={role} id={`role-${role}`} value={role} labelText={`${rolePresets[role].label} — ${rolePresets[role].description}`} />)}
      </RadioButtonGroup>
      <Select id="prototype-scenario" labelText="Data state" helperText="Applies to every list and detail view." value={store.scenario} onChange={(event) => store.setScenario(event.target.value as Scenario)}>
        <SelectItem value="normal" text="Realistic data" />
        <SelectItem value="loading" text="Loading" />
        <SelectItem value="error" text="Request failed" />
        <SelectItem value="empty" text="Empty" />
      </Select>
      <Select id="prototype-connection-test" labelText="Connection test" helperText="Result of “Test connection” in the machine setup." value={store.connectionTest} onChange={(event) => store.setConnectionTest(event.target.value as ConnectionTestMode)}>
        <SelectItem value="success" text="Success" />
        <SelectItem value="unreachable" text="Printer unreachable" />
        <SelectItem value="wrong_code" text="Wrong access code" />
      </Select>
      <SignageSimulationControls />
      <Button kind="tertiary" size="sm" renderIcon={Reset} onClick={store.reset}>Reset prototype data</Button>
    </Stack>
  );
}

export function PrototypeApp() {
  const location = useLocation();
  // The fullscreen player is its own app: no header, no side navigation.
  if (location.pathname.startsWith('/signage/play/')) return <Routes><Route path="/signage/play/:displayId" element={<PlayerPage />} /></Routes>;
  return <Shell />;
}

function Shell() {
  const store = useStore();
  const location = useLocation();
  const narrow = useIsNarrow();
  const [navOpen, setNavOpen] = useState(!narrow);
  const [panelOpen, setPanelOpen] = useState(false);
  const allowed = (item: SalesNavItem) => item.needs.some((group) => group.every((permission) => store.can(permission)));
  const salesItems = SALES_NAV.filter(allowed);
  const signageItems = SIGNAGE_NAV.filter(allowed);
  const settingsItems = SETTINGS_NAV.filter(allowed);
  useEffect(() => { setNavOpen(!narrow); }, [narrow]);
  useEffect(() => { if (narrow) setNavOpen(false); }, [narrow, location.pathname]);
  useEffect(() => { document.getElementById('main-content')?.scrollTo?.(0, 0); window.scrollTo(0, 0); }, [location.pathname]);

  return (
    <div className="app-shell">
      <Theme theme="g100">
        <Header aria-label="Makerspace Core">
          <SkipToContent onClick={(event) => { event.preventDefault(); document.getElementById('main-content')?.focus(); }} />
          <HeaderMenuButton aria-label={navOpen ? 'Close navigation' : 'Open navigation'} isActive={navOpen} isCollapsible onClick={() => setNavOpen((open) => !open)} />
          <HeaderName as={Link} to="/" prefix="Makerspace">Core</HeaderName>
          <HeaderGlobalBar>
            <Tag type="purple" size="sm" className="prototype-badge">Prototype · {rolePresets[store.role].label}</Tag>
            <HeaderGlobalAction aria-label={panelOpen ? 'Close prototype controls' : 'Open prototype controls'} tooltipAlignment="end" isActive={panelOpen} onClick={() => setPanelOpen((open) => !open)}>
              <Chemistry size={20} />
            </HeaderGlobalAction>
          </HeaderGlobalBar>
          <HeaderPanel expanded={panelOpen} className="prototype-panel"><PrototypeControls /></HeaderPanel>
          <SideNav aria-label="Workshop navigation" expanded={navOpen} isFixedNav isPersistent={false} onOverlayClick={() => setNavOpen(false)}>
            <SideNavItems>
              <li className="app-side-nav__heading prototype-nav__heading">Workshop</li>
              {NAV.map((item) => {
                const active = item.match(location.pathname);
                return (
                  <SideNavLink key={item.to} as={Link} to={item.to} renderIcon={item.icon} isActive={active} aria-current={active ? 'page' : undefined} onClick={() => narrow && setNavOpen(false)}>
                    {item.label}
                  </SideNavLink>
                );
              })}
              {([['Sales & payments', salesItems], ['Signage', signageItems], ['Settings', settingsItems]] as [string, SalesNavItem[]][]).map(([heading, items]) => items.length > 0 && (
                <Fragment key={heading}>
                  <li className="app-side-nav__heading prototype-nav__heading">{heading}</li>
                  {items.map((item) => {
                    const active = item.match(location.pathname);
                    return (
                      <SideNavLink key={item.to} as={Link} to={item.to} renderIcon={item.icon} isActive={active} aria-current={active ? 'page' : undefined} onClick={() => narrow && setNavOpen(false)}>
                        {item.label}
                      </SideNavLink>
                    );
                  })}
                </Fragment>
              ))}
            </SideNavItems>
          </SideNav>
        </Header>
      </Theme>
      <main id="main-content" tabIndex={-1} className={`app-main${navOpen && !narrow ? ' app-main--nav-expanded' : ''}`}>
        <Routes>
          <Route path="/" element={<OverviewPage />} />
          <Route path="/jobs" element={<JobsPage />} />
          <Route path="/jobs/runs/:printId" element={<PrintDetailPage />} />
          <Route path="/jobs/prints/:printId" element={<LegacyRunRedirect />} />
          <Route path="/jobs/:jobId" element={<JobDetailPage />} />
          <Route path="/machines" element={<MachinesPage />} />
          <Route path="/machines/:machineId" element={<MachineDetailPage />} />
          <Route path="/inventory" element={<InventoryPage />} />
          <Route path="/inventory/materials/:materialId" element={<MaterialDetailPage />} />
          <Route path="/inventory/spools/:spoolId" element={<SpoolDetailPage />} />
          <Route path="/statistics" element={<StatisticsPage />} />
          <Route path="/sales" element={<SalesOverviewPage />} />
          <Route path="/sales/counter" element={<Navigate to="/sales/orders" replace />} />
          <Route path="/sales/invoicing/*" element={<Navigate to="/sales/orders?invoice=draft,submitted" replace />} />
          <Route path="/sales/customers/*" element={<Navigate to="/sales/orders" replace />} />
          <Route path="/sales/orders" element={<OrdersPage />} />
          <Route path="/sales/orders/:orderId" element={<OrderDetailPage />} />
          <Route path="/sales/orders/:orderId/receipt" element={<ReceiptPage />} />
          <Route path="/sales/payments" element={<PaymentsPage />} />
          <Route path="/sales/payments/:paymentId" element={<PaymentDetailPage />} />
          <Route path="/sales/pricing" element={<PricingPage />} />
          <Route path="/signage" element={<DisplaysPage />} />
          <Route path="/signage/displays/:displayId" element={<DisplayDetailPage />} />
          <Route path="/signage/content" element={<ContentPage />} />
          <Route path="/signage/scenes/:sceneId" element={<SceneEditorPage />} />
          <Route path="/signage/playlists/:playlistId" element={<PlaylistDetailPage />} />
          <Route path="/signage/media" element={<MediaPage />} />
          <Route path="/settings/local-services" element={<LocalServicesPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <div className="prototype-toasts" aria-live="polite">
        {store.toasts.map((toast) => toast.action
          ? <ActionToast key={toast.id} toast={toast} />
          : <ToastNotification key={toast.id} kind={toast.kind} lowContrast timeout={5000} title={toast.title} subtitle={toast.subtitle} onClose={() => { store.dismissToast(toast.id); return false; }} onCloseButtonClick={() => store.dismissToast(toast.id)} />)}
      </div>
    </div>
  );
}
