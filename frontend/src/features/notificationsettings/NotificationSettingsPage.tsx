import { Button, Link as CarbonLink } from '@carbon/react';
import { Logout } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { BrandMark } from '../../app/BrandMark';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { ToastProvider } from '../../app/toasts';
import { isRestrictedSession, useCurrentUser, useLogout } from '../auth/auth';
import { useBranding, usePageTitle } from '../branding/branding';
import { ConsentCards } from '../mynotifications/ConsentCards';
import { ownSettingsQuery } from '../mynotifications/queries';
import { ReachingRulesTable } from '../mynotifications/ReachingRulesTable';
import '../mynotifications/mynotifications.scss';
import './notificationSettingsPage.scss';

/**
 * The page behind the link in every mail: the signed-in person's consents, the rules that reach them and the
 * check-out feedback switch, outside the application shell. A restricted session (a visitor who signed in with a
 * mailed code) may only call the endpoints this page uses, so personal subscriptions live in the app and are only
 * linked for full sessions.
 */
export default function NotificationSettingsPage() {
  usePageTitle('Notification settings');
  const currentUser = useCurrentUser();
  const settings = useQuery(ownSettingsQuery());
  const restricted = isRestrictedSession(currentUser);

  return (
    <ToastProvider>
      <div className="ns-page">
        <PageHeader />
        <main className="ns-page__main">
          <div className="ns-page__intro">
            <h1>Your notification settings</h1>
            <p>
              What we may send you, which rules reach you and how. Changes are saved as soon as you make them.
              {!restricted && (
                <>
                  {' '}
                  Your own subscriptions are in the app:{' '}
                  <CarbonLink as={Link} to="/profile/notifications">
                    Open in the app
                  </CarbonLink>
                  .
                </>
              )}
            </p>
          </div>
          {settings.isError ? (
            <ErrorState
              title="Unable to load your settings"
              message="Check the connection and try again."
              onRetry={() => void settings.refetch()}
            />
          ) : !settings.data ? (
            <FullPageLoading label="Loading your notification settings" />
          ) : (
            <div className="mn-page">
              <ConsentCards settings={settings.data} />
              <ReachingRulesTable settings={settings.data} />
            </div>
          )}
        </main>
      </div>
    </ToastProvider>
  );
}

function PageHeader() {
  const branding = useBranding();
  const currentUser = useCurrentUser();
  const logout = useLogout();
  return (
    <header className="ns-page__header">
      <div className="ns-page__brand">
        <BrandMark className="ns-page__logo" />
        <span className="ns-page__brand-name">{branding.identity.displayName}</span>
      </div>
      <div className="ns-page__who">
        <span className="ns-page__who-name">
          {currentUser.person.firstName} {currentUser.person.lastName}
        </span>
        <Button kind="ghost" size="sm" renderIcon={Logout} disabled={logout.isPending} onClick={() => logout.mutate()}>
          Sign out
        </Button>
      </div>
    </header>
  );
}
