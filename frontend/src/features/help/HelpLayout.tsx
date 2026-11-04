import { useEffect, useState, type ReactNode } from 'react';
import { Accordion, AccordionItem } from '@carbon/react';
import { Link, useLocation } from 'react-router-dom';
import { useCurrentUser } from '../auth/auth';
import { useGuideRegistry } from '../guides/registry';
import { helpAreas } from './areas';
import { articles } from './articles';

const wideQuery = '(min-width: 66rem)';

/** True from the breakpoint where the topic menu sits beside the content; wide when the browser cannot tell. */
function useWideLayout() {
  const [wide, setWide] = useState(() =>
    typeof window.matchMedia === 'function' ? window.matchMedia(wideQuery).matches : true,
  );
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(wideQuery);
    const update = () => setWide(query.matches);
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  return wide;
}

/** The topic menu: every area the person may see with its articles, each linking to its section of the help home. */
function TopicList({ currentArticleId }: { currentArticleId?: string }) {
  const currentUser = useCurrentUser();
  const registry = useGuideRegistry();
  const location = useLocation();
  const guides = (registry.data ?? []).filter((guide) => guide.requires(currentUser));
  const visible = articles.filter((article) => article.requires(currentUser));
  const onHome = !currentArticleId && location.pathname.replace(/\/$/, '') === '/help';

  return (
    <nav aria-label="Help topics" className="help-nav">
      <ul className="help-nav__groups">
        <li>
          <Link to="/help" className="help-nav__link help-nav__link--home" aria-current={onHome ? 'page' : undefined}>
            All help topics
          </Link>
        </li>
        {helpAreas.map((area) => {
          const areaArticles = visible.filter((article) => article.area === area.id);
          const areaHasGuides = guides.some((guide) => guide.area === area.id);
          if (areaArticles.length === 0 && !areaHasGuides) return null;
          return (
            <li key={area.id}>
              <Link to={`/help#${area.id}`} className="help-nav__group">
                {area.title}
              </Link>
              <ul>
                {areaArticles.map((article) => (
                  <li key={article.id}>
                    <Link
                      to={`/help/${article.id}`}
                      className="help-nav__link"
                      aria-current={article.id === currentArticleId ? 'page' : undefined}
                    >
                      {article.title}
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** Content on a solid panel with the topic menu on the right; above the content in a collapsible on narrow screens. */
export function HelpLayout({ children, currentArticleId }: { children: ReactNode; currentArticleId?: string }) {
  const wide = useWideLayout();
  const topics = <TopicList currentArticleId={currentArticleId} />;
  return (
    <div className="help-layout">
      <div className="help-layout__main">{children}</div>
      <aside className="help-layout__aside" aria-label="Topics">
        {wide ? (
          <div className="help-panel help-panel--menu">
            <h2 className="help-layout__aside-title">Topics</h2>
            {topics}
          </div>
        ) : (
          <Accordion isFlush>
            <AccordionItem title="Topics">{topics}</AccordionItem>
          </Accordion>
        )}
      </aside>
    </div>
  );
}
