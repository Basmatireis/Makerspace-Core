import { ContentSwitcher, Switch } from '@carbon/react';

export type Section = { id: string; label: string };

/** Switches between sibling tables from inside a table toolbar, instead of page tabs around the table. */
export function SectionSwitcher({ sections, selected, onChange, label }: { sections: Section[]; selected: string; onChange: (id: string) => void; label: string }) {
  return (
    <div className="mj-toolbar-switcher">
      <ContentSwitcher size="lg" aria-label={label} selectedIndex={Math.max(0, sections.findIndex((section) => section.id === selected))} onChange={({ index }) => onChange(sections[index ?? 0].id)}>
        {sections.map((section) => <Switch key={section.id} name={section.id} text={section.label} />)}
      </ContentSwitcher>
    </div>
  );
}
