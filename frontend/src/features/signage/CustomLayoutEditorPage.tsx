import './styles.scss';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import { ApiError } from '../../api/http-client';
import { PageShell } from '../../app/PageShell';
import { EmptyState, ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser } from '../auth/auth';
import { hasPermission, PermissionId } from '../auth/permissions';
import { errorMessage } from './helpers';
import { LayoutEditor } from './LayoutEditor';
import { customLayoutQuery } from './layoutQueries';
import { signagePaths } from './paths';

const crumbs = [
  { label: 'Signage' },
  { label: 'Content', to: signagePaths.content() },
  { label: 'Layouts', to: signagePaths.content('layouts') },
];

/** `/signage/layouts/new` and `/signage/layouts/:layoutId`. */
export function CustomLayoutEditorPage() {
  const { layoutId } = useParams();
  const canEdit = hasPermission(useCurrentUser(), PermissionId.signagecontentmanage);
  if (!layoutId) {
    return canEdit ? (
      <LayoutEditor key="new" canEdit />
    ) : (
      <PageShell title="New layout" width="wide" breadcrumbs={crumbs}>
        <EmptyState title="You cannot create layouts" description="Your role can see layouts but not change them." />
      </PageShell>
    );
  }
  return <ExistingLayout layoutId={layoutId} canEdit={canEdit} />;
}

function ExistingLayout({ layoutId, canEdit }: { layoutId: string; canEdit: boolean }) {
  const queryClient = useQueryClient();
  const query = useQuery(customLayoutQuery(layoutId));
  if (query.isPending)
    return (
      <PageShell title="Layout" width="wide" breadcrumbs={crumbs}>
        <FullPageLoading label="Loading layout" />
      </PageShell>
    );
  if (query.isError) {
    const missing = query.error instanceof ApiError && query.error.status === 404;
    return (
      <PageShell title={missing ? 'Layout not found' : 'Layout'} width="wide" breadcrumbs={crumbs}>
        {missing ? (
          <EmptyState title="This layout does not exist" description="It may have been deleted." />
        ) : (
          <ErrorState
            message={errorMessage(query.error, 'The layout could not be loaded.')}
            onRetry={() => void query.refetch()}
          />
        )}
      </PageShell>
    );
  }
  return (
    // The version in the key remounts the form with the latest data after a conflict.
    <LayoutEditor
      key={`${query.data.id}-${query.data.version}`}
      layout={query.data}
      canEdit={canEdit}
      onReload={() => void queryClient.refetchQueries({ queryKey: customLayoutQuery(layoutId).queryKey })}
    />
  );
}
