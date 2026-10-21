import './public.scss';
import { Login } from '@carbon/icons-react';
import { Button, SkeletonText, Theme } from '@carbon/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  cancelOwnPublicEventAssignment,
  downloadPublicEventFile,
  getGetPublicEventBannerUrl,
} from '../../api/generated/public-events/public-events';
import type { EventSignup, PublicEventRequirement, PublicEventShift } from '../../api/generated/models';
import { DestructiveActionDialog } from '../../app/DestructiveActionDialog';
import { currentUserQueryOptions } from '../auth/auth';
import { useBranding, usePageTitle } from '../branding/branding';
import { eventKeys, ownEventAssignmentsQueryOptions, publicEventQueryOptions } from './queries';
import { MoveSignupDialog } from './public/MoveSignupDialog';
import { PublicPageView } from './public/PublicPageView';
import { SignupDialog } from './public/SignupDialog';

/** Visitor page, rendered outside the app shell (no navigation): `/events/public/:publicId`. */
export function PublicEventPage() {
  const { publicId = '' } = useParams();
  const client = useQueryClient();
  const branding = useBranding();
  const event = useQuery(publicEventQueryOptions(publicId));
  const currentUser = useQuery(currentUserQueryOptions());
  const signedIn = currentUser.isSuccess;
  const own = useQuery(ownEventAssignmentsQueryOptions(publicId, signedIn));
  const [signup, setSignup] = useState<{ shift: PublicEventShift; requirement: PublicEventRequirement } | null>(null);
  const [moving, setMoving] = useState<EventSignup | null>(null);
  const [cancelling, setCancelling] = useState<EventSignup | null>(null);
  usePageTitle(event.data?.title ?? 'Event');
  const cancel = useMutation({
    mutationFn: (assignment: EventSignup) =>
      cancelOwnPublicEventAssignment(publicId, assignment.id, { expectedVersion: assignment.version }),
    onSuccess: async () => {
      setCancelling(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: eventKeys.public(publicId) }),
        client.invalidateQueries({ queryKey: eventKeys.own(publicId) }),
      ]);
    },
  });
  const download = async (id: string, name: string) => {
    const blob = await downloadPublicEventFile(publicId, id);
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Theme theme="white" className="ev-site">
      <header className="ev-site__bar">
        <div className="ev-site__brand">
          {branding.assets.compactLogoUrl && <img src={branding.assets.compactLogoUrl} alt="" />}
          <strong>{branding.identity.applicationName}</strong>
        </div>
        {signedIn ? (
          <Button as={Link} to="/dashboard" kind="ghost" size="sm">
            Dashboard
          </Button>
        ) : (
          <Button as={Link} to="/login" kind="ghost" size="sm" renderIcon={Login}>
            Sign in
          </Button>
        )}
      </header>
      <main className="ev-site__main">
        {event.isPending && (
          <div className="ev-public">
            <div className="ev-public__body" aria-label="Loading event">
              <SkeletonText heading />
              <SkeletonText paragraph lineCount={6} />
            </div>
          </div>
        )}
        {event.isError && (
          <div className="ev-public ev-public--missing">
            <div className="ev-public__body">
              <h1>This page is not available</h1>
              <p>The link may be wrong or expired, or the event is not public.</p>
            </div>
          </div>
        )}
        {event.data && (
          <PublicPageView
            event={event.data}
            mode="live"
            signedIn={signedIn}
            bannerUrl={getGetPublicEventBannerUrl(publicId)}
            own={own.data?.items}
            onSignup={(shift, requirement) => setSignup({ shift, requirement })}
            onMove={setMoving}
            onCancel={setCancelling}
            onDownload={(file) => void download(file.id, file.originalFilename)}
          />
        )}
      </main>
      {signup && event.data && (
        <SignupDialog
          event={event.data}
          shift={signup.shift}
          requirement={signup.requirement}
          person={currentUser.data?.person}
          onClose={() => setSignup(null)}
        />
      )}
      {moving && event.data && (
        <MoveSignupDialog event={event.data} assignment={moving} onClose={() => setMoving(null)} />
      )}
      <DestructiveActionDialog
        open={Boolean(cancelling)}
        title="Cancel your signup?"
        confirmLabel="Cancel signup"
        pending={cancel.isPending}
        error={cancel.isError ? 'The signup changed or can no longer be cancelled.' : undefined}
        onClose={() => setCancelling(null)}
        onConfirm={() => cancelling && cancel.mutate(cancelling)}
      >
        <p>Your place becomes available to another helper. The cancelled signup remains in event history.</p>
      </DestructiveActionDialog>
    </Theme>
  );
}
