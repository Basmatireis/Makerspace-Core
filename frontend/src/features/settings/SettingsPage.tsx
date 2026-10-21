import { Column, ClickableTile as CarbonClickableTile, Grid, Search } from '@carbon/react';
import { useEffect, useState, type ComponentProps, type ComponentType } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { PageShell } from '../../app/PageShell';
import { EmptyState } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { settingsGroups, visibleSettingsItems } from './settingsCatalog';

type RouterClickableTileProps = Omit<ComponentProps<typeof CarbonClickableTile>, 'href'> & {
  as: typeof Link;
  to: string;
};

// Carbon's ClickableTile forwards polymorphic Link props at runtime, but its
// current public type omits them.
const ClickableTile = CarbonClickableTile as ComponentType<RouterClickableTileProps>;

export function SettingsPage() {
  const currentUser = useCurrentUser();
  const { hash } = useLocation();
  const [query, setQuery] = useState('');
  const items = visibleSettingsItems(currentUser);
  const needle = query.trim().toLowerCase();
  const matching = needle
    ? items.filter((item) => `${item.title} ${item.description}`.toLowerCase().includes(needle))
    : items;

  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView?.();
  }, [hash]);

  return (
    <PageShell title="Settings" description="Administration tools available to your account.">
      {items.length > 6 && (
        <Search
          size="lg"
          labelText="Filter settings"
          placeholder="Filter settings"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onClear={() => setQuery('')}
        />
      )}
      {settingsGroups.map((group) => {
        const groupItems = matching.filter((item) => item.group === group.id);
        if (groupItems.length === 0) return null;
        return (
          <section
            key={group.id}
            id={group.id}
            aria-labelledby={`settings-group-${group.id}`}
            className="settings-group"
          >
            <div>
              <h2 id={`settings-group-${group.id}`}>{group.title}</h2>
              <p className="settings-section__description">{group.description}</p>
            </div>
            <Grid condensed className="settings-grid">
              {groupItems.map((item) => (
                <Column key={item.id} sm={4} md={4} lg={4} xlg={4}>
                  <ClickableTile as={Link} to={item.path} className="settings-tile">
                    <item.icon size={32} />
                    <h3>{item.title}</h3>
                    <p>{item.description}</p>
                  </ClickableTile>
                </Column>
              ))}
            </Grid>
          </section>
        );
      })}
      {matching.length === 0 && <EmptyState title="No matching settings" description="Try a different search term." />}
    </PageShell>
  );
}
