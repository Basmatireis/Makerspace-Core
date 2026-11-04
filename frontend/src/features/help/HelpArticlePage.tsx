import './help.scss';
import { Button, Layer, Link as CarbonLink, Tile } from '@carbon/react';
import { ArrowLeft, ArrowRight, PlayFilledAlt } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { Link, useParams } from 'react-router-dom';
import { NotFoundPage } from '../../app/NotFoundPage';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { useGuides } from '../guides/GuideProvider';
import { useGuideRegistry } from '../guides/registry';
import { helpAreas } from './areas';
import { articles, type HelpArticle } from './articles';
import { HelpLayout } from './HelpLayout';

function ArticleBody({ article }: { article: HelpArticle }) {
  const currentUser = useCurrentUser();
  const { startGuide } = useGuides();
  const registry = useGuideRegistry();
  const body = useQuery({
    queryKey: ['help', 'article', article.id],
    queryFn: article.load,
    staleTime: Infinity,
  });
  const related = (registry.data ?? []).filter(
    (guide) => article.relatedGuides?.includes(guide.id) && guide.requires(currentUser),
  );
  // Previous and next within the same area, among the articles the person may read.
  const siblings = articles.filter((candidate) => candidate.area === article.area && candidate.requires(currentUser));
  const index = siblings.findIndex((candidate) => candidate.id === article.id);
  const previous = siblings[index - 1];
  const next = siblings[index + 1];

  return (
    <div className="help-panel help-article">
      <Layer>
        <p className="help-article__summary">{article.summary}</p>
        {body.isPending && <InlineLoadingState label="Loading article" />}
        {body.isError && (
          <ErrorState
            title="Article unavailable"
            message="The article could not be loaded."
            onRetry={() => void body.refetch()}
          />
        )}
        {body.data && (
          <div className="markdown-content help-prose">
            <ReactMarkdown
              components={{
                a: ({ node, href, ...props }) => {
                  void node;
                  if (href?.startsWith('/')) return <CarbonLink as={Link} to={href} {...props} />;
                  const external = /^https?:\/\//i.test(href ?? '');
                  return (
                    <a href={href} {...props} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} />
                  );
                },
              }}
            >
              {body.data}
            </ReactMarkdown>
          </div>
        )}
        {related.length > 0 && (
          <Tile className="help-tryit">
            <h2 className="help-tryit__title">Try it</h2>
            <p>Learn this in the app with a guided tour or a workflow demo.</p>
            <div className="help-tryit__actions">
              {related.map((guide) => (
                <Button
                  key={guide.id}
                  kind="tertiary"
                  size="md"
                  renderIcon={PlayFilledAlt}
                  onClick={() => startGuide(guide.id)}
                >
                  {`Start the related guide: ${guide.title}`}
                </Button>
              ))}
            </div>
          </Tile>
        )}
        {(previous || next) && (
          <nav aria-label="More articles" className="help-pager">
            {previous ? (
              <Link to={`/help/${previous.id}`} className="help-pager__link" rel="prev">
                <span className="help-pager__label">
                  <ArrowLeft size={16} aria-hidden="true" /> Previous
                </span>
                <span className="help-pager__title">{previous.title}</span>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link to={`/help/${next.id}`} className="help-pager__link help-pager__link--next" rel="next">
                <span className="help-pager__label">
                  Next <ArrowRight size={16} aria-hidden="true" />
                </span>
                <span className="help-pager__title">{next.title}</span>
              </Link>
            )}
          </nav>
        )}
      </Layer>
    </div>
  );
}

export function HelpArticlePage() {
  const { articleId } = useParams();
  const currentUser = useCurrentUser();
  const article = articles.find((candidate) => candidate.id === articleId);
  if (!article || !article.requires(currentUser)) return <NotFoundPage />;
  const area = helpAreas.find((candidate) => candidate.id === article.area);
  return (
    <PageShell
      title={article.title}
      width="wide"
      breadcrumbs={[{ label: 'Help', to: '/help' }, ...(area ? [{ label: area.title, to: `/help#${area.id}` }] : [])]}
    >
      <HelpLayout currentArticleId={article.id}>
        <ArticleBody article={article} />
      </HelpLayout>
    </PageShell>
  );
}
