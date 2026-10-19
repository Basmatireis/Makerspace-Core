import { Tab, TabList, TabPanel, TabPanels, Tabs } from '@carbon/react';
import './sectionSwitcher.scss';

export type Section = { id: string; label: string };

/** Switches between sibling tables from inside a table toolbar: contained tabs that sit flush with the toolbar. */
export function SectionSwitcher({ sections, selected, onChange, label }: { sections: Section[]; selected: string; onChange: (id: string) => void; label: string }) {
  return (
    <div className="app-toolbar-switcher">
      <Tabs selectedIndex={Math.max(0, sections.findIndex((section) => section.id === selected))} onChange={({ selectedIndex }) => onChange(sections[selectedIndex].id)}>
        <TabList aria-label={label} contained>
          {sections.map((section) => <Tab key={section.id}>{section.label}</Tab>)}
        </TabList>
        {/* Carbon tabs point aria-controls at a panel; the sections themselves render outside, so the panels stay empty. */}
        <TabPanels>
          {sections.map((section) => <TabPanel key={section.id} className="app-toolbar-switcher__panel" />)}
        </TabPanels>
      </Tabs>
    </div>
  );
}
