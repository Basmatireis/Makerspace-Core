import './help.scss';
import { useState } from 'react';
import { Button, Link as CarbonLink, Search, Stack, Tag, Tile } from '@carbon/react';
import { PlayFilledAlt, Renew } from '@carbon/icons-react';
import { Link } from 'react-router-dom';
import { fuzzySort } from '../../app/fuzzy';
import { InlineLoadingState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { useGuides } from '../guides/GuideProvider';
import { useGuideProgress, useResetGuideProgress } from '../guides/progress';
import { useGuideRegistry } from '../guides/registry';
import type { GuideDefinition } from '../guides/types';
import { helpAreas } from './areas';
import { articles, type HelpArticle } from './articles';

type Entry = { kind: 'guide'; guide: GuideDefinition } | { kind: 'article'; article: HelpArticle };

const entryText = (entry: Entry) =>
  entry.kind === 'guide'
    ? `${entry.guide.title} ${entry.guide.summary}`
    : `${entry.article.title} ${entry.article.summary}`;

function GuideCard({ guide, completed }: { guide: GuideDefinition; completed: boolean }) {
  const { startGuide } = useGuides();
  return (
    <Tile className="help-card">
      <div className="help-card__tags">
        <Tag type={guide.demo ? 'purple' : 'blue'} size="sm">
          {guide.demo ? 'Workflow · Demo' : 'Tour'}
        </Tag>
        {completed && (
          <Tag type="green" size="sm">
            Completed
          </Tag>
        )}
      </div>
      <h3>{guide.title}</h3>
      <p>{guide.summary}</p>
      <p>{guide.duration}</p>
      <Button
        className="help-card__action"
        kind="tertiary"
        size="sm"
        renderIcon={PlayFilledAlt}
        onClick={() => startGuide(guide.id)}
      >
        Start
      </Button>
    </Tile>
  );
}

function ArticleItem({ article }: { article: HelpArticle }) {
  return (
    <li>
      <CarbonLink as={Link} to={`/help/${article.id}`}>
        {article.title}
      </CarbonLink>
      <p>{article.summary}</p>
    </li>
  );
}

function Items({ entries, completed }: { entries: Entry[]; completed: ReadonlySet<string> }) {
  const guideEntries = entries.filter((entry) => entry.kind === 'guide');
  const articleEntries = entries.filter((entry) => entry.kind === 'article');
  return (
    <>
      {guideEntries.length > 0 && (
        <div className="help-grid">
          {guideEntries.map(({ guide }) => (
            <GuideCard key={guide.id} guide={guide} completed={completed.has(guide.id)} />
          ))}
        </div>
      )}
      {articleEntries.length > 0 && (
        <ul className="help-articles">
          {articleEntries.map(({ article }) => (
            <ArticleItem key={article.id} article={article} />
          ))}
        </ul>
      )}
    </>
  );
}

export function HelpPage() {
  const currentUser = useCurrentUser();
  const registry = useGuideRegistry();
  const progress = useGuideProgress();
  const reset = useResetGuideProgress();
  const [query, setQuery] = useState('');

  const completed = new Set(
    progress.data?.items.filter((item) => item.status === 'completed').map((item) => item.guideId),
  );
  const entries: Entry[] = [
    ...(registry.data ?? [])
      .filter((guide) => guide.requires(currentUser))
      .map((guide): Entry => ({ kind: 'guide', guide })),
    ...articles
      .filter((article) => article.requires(currentUser))
      .map((article): Entry => ({ kind: 'article', article })),
  ];
  const searching = query.trim() !== '';
  const results = searching ? fuzzySort(entries, query, entryText) : [];
  const areaOf = (entry: Entry) => (entry.kind === 'guide' ? entry.guide.area : entry.article.area);

  return (
    <PageShell
      title="Help"
      actions={
        <Button kind="ghost" size="md" renderIcon={Renew} disabled={reset.isPending} onClick={() => reset.mutate()}>
          Show the tours again
        </Button>
      }
    >
      <Stack gap={7}>
        <Search
          className="help-search"
          size="lg"
          labelText="Search help"
          placeholder="Search guides and articles"
          closeButtonLabelText="Clear search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {registry.isPending && <InlineLoadingState label="Loading guides" />}
        {searching ? (
          <section className="help-section" aria-label="Search results">
            {results.length > 0 ? (
              <Items entries={results} completed={completed} />
            ) : (
              <p>{`Nothing in the help center matches “${query.trim()}”.`}</p>
            )}
          </section>
        ) : (
          helpAreas.map((area) => {
            const areaEntries = entries.filter((entry) => areaOf(entry) === area.id);
            if (areaEntries.length === 0) return null;
            return (
              <section key={area.id} className="help-section" aria-labelledby={`help-${area.id}`}>
                <h2 id={`help-${area.id}`}>{area.title}</h2>
                <Items entries={areaEntries} completed={completed} />
              </section>
            );
          })
        )}
      </Stack>
    </PageShell>
  );
}
