import './help.scss';
import { useEffect, useState } from 'react';
import { Button, ClickableTile, Layer, Search, Stack, Tag, Tile } from '@carbon/react';
import { ArrowRight, PlayFilledAlt, Renew, Time } from '@carbon/icons-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { fuzzySort } from '../../app/fuzzy';
import { InlineLoadingState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { useGuides } from '../guides/GuideProvider';
import { useGuideProgress, useResetGuideProgress } from '../guides/progress';
import { useGuideRegistry } from '../guides/registry';
import type { GuideDefinition } from '../guides/types';
import { helpAreas } from './areas';
import { HelpLayout } from './HelpLayout';
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
      <h4 className="help-card__title">{guide.title}</h4>
      <p className="help-card__summary">{guide.summary}</p>
      <p className="help-card__duration">
        <Time size={16} aria-hidden="true" />
        {guide.duration}
      </p>
      <Button
        className="help-card__action"
        kind="tertiary"
        size="sm"
        aria-label={`Start ${guide.title}`}
        renderIcon={PlayFilledAlt}
        onClick={() => startGuide(guide.id)}
      >
        Start
      </Button>
    </Tile>
  );
}

/** A clickable card that is a real link (Carbon's ClickableTile renders a plain anchor) and navigates in-app. */
function ArticleCard({ article }: { article: HelpArticle }) {
  const navigate = useNavigate();
  const to = `/help/${article.id}`;
  return (
    <ClickableTile
      className="help-card help-card--article"
      href={to}
      renderIcon={ArrowRight}
      onClick={(event) => {
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey) return;
        event.preventDefault();
        void navigate(to);
      }}
    >
      <h4 className="help-card__title">{article.title}</h4>
      <p className="help-card__summary">{article.summary}</p>
    </ClickableTile>
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
        <div className="help-grid">
          {articleEntries.map(({ article }) => (
            <ArticleCard key={article.id} article={article} />
          ))}
        </div>
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

  const location = useLocation();
  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [location.hash, registry.isPending]);

  return (
    <PageShell
      title="Help"
      width="wide"
      actions={
        <Button kind="ghost" size="md" renderIcon={Renew} disabled={reset.isPending} onClick={() => reset.mutate()}>
          Show the tours again
        </Button>
      }
    >
      <HelpLayout>
        <div className="help-panel">
          <Layer>
            <Stack gap={8}>
              <div>
                <p className="help-lead">Guides, tours and articles for working in Makerspace Core.</p>
                <Search
                  className="help-search"
                  size="lg"
                  labelText="Search help"
                  placeholder="Search guides and articles"
                  closeButtonLabelText="Clear search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                />
              </div>
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
                    <section key={area.id} id={area.id} className="help-section" aria-labelledby={`help-${area.id}`}>
                      <h2 id={`help-${area.id}`} className="help-section__title">
                        {area.title}
                      </h2>
                      <Items entries={areaEntries} completed={completed} />
                    </section>
                  );
                })
              )}
            </Stack>
          </Layer>
        </div>
      </HelpLayout>
    </PageShell>
  );
}
