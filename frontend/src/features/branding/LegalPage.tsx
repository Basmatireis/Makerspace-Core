import { Button, InlineNotification, Stack, Tile } from '@carbon/react';
import { useQuery } from '@tanstack/react-query';
import ReactMarkdown from 'react-markdown';
import { Link } from 'react-router-dom';
import { getPublicLegalDocument } from '../../api/generated/branding/branding';
import { BrandMark } from '../../app/BrandMark';
import { ErrorState, InlineLoadingState } from '../../app/PageState';
import { useBranding, usePageTitle } from './branding';
import { LegalLinks } from './LegalLinks';

export function LegalPage({ kind }: { kind: 'imprint' | 'privacy' }) {
  const branding = useBranding();
  const documentQuery = useQuery({ queryKey: ['branding', 'legal', kind], queryFn: ({ signal }) => getPublicLegalDocument(kind, { signal }) });
  const fallbackTitle = kind === 'imprint' ? 'Imprint' : 'Privacy policy';
  usePageTitle(documentQuery.data?.title ?? fallbackTitle);

  return (
    <main className="public-page legal-page">
      <Stack gap={7}>
        <div className="public-brand-heading">
          {branding.assets.logoUrl && <BrandMark kind="logo" className="public-brand-heading__logo" />}
          <div><span>{branding.identity.legalOrganizationName}</span><strong>{branding.identity.displayName}</strong></div>
        </div>
        {documentQuery.isPending && <InlineLoadingState label={`Loading ${fallbackTitle.toLowerCase()}`} />}
        {documentQuery.isError && <ErrorState title={`${fallbackTitle} unavailable`} message="The legal information could not be loaded." onRetry={() => void documentQuery.refetch()} />}
        {documentQuery.data && <Tile className="legal-document"><Stack gap={6}>
          <h1>{documentQuery.data.title}</h1>
          {documentQuery.data.mode === 'external' && documentQuery.data.externalUrl ? (
            <Stack gap={4}><InlineNotification kind="info" lowContrast hideCloseButton title="Hosted externally" subtitle="This legal document is maintained on another website." /><Button href={documentQuery.data.externalUrl} target="_blank" rel="noopener noreferrer">Open document</Button></Stack>
          ) : documentQuery.data.markdown ? (
            <div className="markdown-content"><ReactMarkdown components={{ a: ({ node, ...props }) => { void node; const external = /^https?:\/\//i.test(props.href ?? ''); return <a {...props} {...(external ? { target: '_blank', rel: 'noopener noreferrer' } : {})} />; } }}>{documentQuery.data.markdown}</ReactMarkdown></div>
          ) : (
            <InlineNotification kind="info" lowContrast hideCloseButton title="Not configured" subtitle="No content has been published for this legal document." />
          )}
          <Button kind="ghost" as={Link} to="/login">Back to sign in</Button>
        </Stack></Tile>}
        <LegalLinks />
      </Stack>
    </main>
  );
}
