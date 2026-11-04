import './help.scss';
import { Button, Link as CarbonLink, Stack } from '@carbon/react';
import { PlayFilledAlt } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { Link, useParams } from 'react-router-dom';
import { NotFoundPage } from '../../app/NotFoundPage';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { PageShell } from '../../app/PageShell';
import { useCurrentUser } from '../auth/auth';
import { useGuides } from '../guides/GuideProvider';
import { useGuideRegistry } from '../guides/registry';
import { articles, type HelpArticle } from './articles';

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

  return (
    <Stack gap={6} className="help-article">
      {body.isPending && <InlineLoadingState label="Loading article" />}
      {body.isError && (
        <ErrorState
          title="Article unavailable"
          message="The article could not be loaded."
          onRetry={() => void body.refetch()}
        />
      )}
      {body.data && (
        <div className="markdown-content">
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
        <div className="help-article__guides">
          {related.map((guide) => (
            <Button key={guide.id} kind="tertiary" renderIcon={PlayFilledAlt} onClick={() => startGuide(guide.id)}>
              {`Start the related guide: ${guide.title}`}
            </Button>
          ))}
        </div>
      )}
    </Stack>
  );
}

export function HelpArticlePage() {
  const { articleId } = useParams();
  const currentUser = useCurrentUser();
  const article = articles.find((candidate) => candidate.id === articleId);
  if (!article || !article.requires(currentUser)) return <NotFoundPage />;
  return (
    <PageShell title={article.title} breadcrumbs={[{ label: 'Help', to: '/help' }]}>
      <ArticleBody article={article} />
    </PageShell>
  );
}
