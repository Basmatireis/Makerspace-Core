import { Tab, TabList, TabPanel, TabPanels, Tabs } from '@carbon/react';
import { Suspense, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SettingsLoading } from './SettingsPageLayout';

export type SettingsTab = {
  key: string;
  label: string;
  panel: ReactNode;
};

type SettingsTabsProps = {
  label: string;
  /** Only tabs the person may use; the first one is the default. */
  tabs: readonly SettingsTab[];
};

/** Carbon tabs whose selection lives in the `?tab=` query parameter; only the selected panel is mounted. */
export function SettingsTabs({ label, tabs }: SettingsTabsProps) {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const selectedIndex = Math.max(
    0,
    tabs.findIndex((tab) => tab.key === requested),
  );
  return (
    <Tabs
      selectedIndex={selectedIndex}
      onChange={({ selectedIndex: next }) =>
        setParams(
          (previous) => {
            const updated = new URLSearchParams(previous);
            updated.set('tab', tabs[next].key);
            return updated;
          },
          { replace: true },
        )
      }
    >
      <TabList aria-label={label}>
        {tabs.map((tab) => (
          <Tab key={tab.key}>{tab.label}</Tab>
        ))}
      </TabList>
      <TabPanels>
        {tabs.map((tab, index) => (
          <TabPanel key={tab.key}>
            {index === selectedIndex && (
              <Suspense fallback={<SettingsLoading label={`Loading ${tab.label}`} />}>{tab.panel}</Suspense>
            )}
          </TabPanel>
        ))}
      </TabPanels>
    </Tabs>
  );
}
