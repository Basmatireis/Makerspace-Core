import { Tab, TabList, TabPanel, TabPanels, Tabs } from '@carbon/react';
import { useSearchParams } from 'react-router-dom';
import { PermissionId } from '../../api/generated/models';
import { SettingsPageLayout } from '../settings/SettingsPageLayout';
import { hasPermission } from '../auth/permissions';
import { useCurrentUser } from '../auth/auth';
import { ConnectorsTab } from '../machinelogbook/components/ConnectorsTab';
import { ToastProvider } from '../machinelogbook/shared/toasts';
import { UpdatesSection } from './UpdatesSection';
import './localServices.scss';

type TabKey = 'connectors' | 'updates';
const tabLabels: Record<TabKey, string> = {
  connectors: 'Printer connectors',
  updates: 'Versions and updates',
};

/** Printer connectors (with the camera relay): the software that runs in the makerspace network next to Core. */
export function LocalServicesPage() {
  const currentUser = useCurrentUser();
  const [params, setParams] = useSearchParams();
  const canManageConnectors = hasPermission(currentUser, PermissionId.printer_connectorsmanage);
  const tabs: TabKey[] = ['connectors', 'updates'];
  const requested = params.get('tab') as TabKey | null;
  const selected = requested && tabs.includes(requested) ? requested : tabs[0];
  return (
    <ToastProvider>
      <SettingsPageLayout
        page="local-services"
        description="Software that runs in the makerspace network next to Core."
        width="wide"
      >
        <Tabs
          selectedIndex={tabs.indexOf(selected)}
          onChange={({ selectedIndex }) =>
            setParams(
              (previous) => {
                const next = new URLSearchParams(previous);
                next.set('tab', tabs[selectedIndex]);
                return next;
              },
              { replace: true },
            )
          }
        >
          <TabList aria-label="Local services sections">
            {tabs.map((key) => (
              <Tab key={key}>{tabLabels[key]}</Tab>
            ))}
          </TabList>
          <TabPanels>
            {tabs.map((key) => (
              <TabPanel key={key}>
                {key === selected && key === 'connectors' && <ConnectorsTab />}
                {key === selected && key === 'updates' && <UpdatesSection canManageConnectors={canManageConnectors} />}
              </TabPanel>
            ))}
          </TabPanels>
        </Tabs>
      </SettingsPageLayout>
    </ToastProvider>
  );
}
