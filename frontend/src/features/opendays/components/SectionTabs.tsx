import { Tab, TabList, TabPanel, TabPanels, Tabs } from '@carbon/react';

export type SectionTab = { id: string; label: string; count?: number };

/** The section tabs under a page head. The sections render outside the tabs, so the panels stay empty. */
export function SectionTabs({
  label,
  sections,
  selected,
  onChange,
}: {
  label: string;
  sections: SectionTab[];
  selected: string;
  onChange: (id: string) => void;
}) {
  return (
    <Tabs
      selectedIndex={Math.max(
        0,
        sections.findIndex((section) => section.id === selected),
      )}
      onChange={({ selectedIndex }) => onChange(sections[selectedIndex].id)}
    >
      <TabList aria-label={label}>
        {sections.map((section) => (
          <Tab key={section.id}>
            {section.label}
            {section.count !== undefined && <span className="od-tab-count">{section.count}</span>}
          </Tab>
        ))}
      </TabList>
      <TabPanels>
        {sections.map((section) => (
          <TabPanel key={section.id} className="od-tab-panel" />
        ))}
      </TabPanels>
    </Tabs>
  );
}
