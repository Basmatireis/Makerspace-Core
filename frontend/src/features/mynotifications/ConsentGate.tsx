import { Button, InlineLoading, InlineNotification, Tile, Toggle } from '@carbon/react';
import { Locked } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { answerOwnNotificationConsents } from '../../api/generated/notification-rules/notification-rules';
import { ErrorState } from '../../app/PageState';
import { authQueryKey, useCurrentUser } from '../auth/auth';
import { LegalLinks } from '../branding/LegalLinks';
import { myNotificationKeys, ownSettingsQuery } from './queries';
import './mynotifications.scss';

/**
 * The question asked once after sign-in, in place of the application: it cannot be dismissed and nothing is
 * preselected, but "Save and continue" works with every answer off. Loaded lazily, only for people who have to answer.
 */
export default function ConsentGate() {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const settings = useQuery(ownSettingsQuery());
  const heading = useRef<HTMLHeadingElement>(null);
  const [granted, setGranted] = useState<Record<string, boolean>>({});

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const entries = settings.data?.consents ?? [];
  const required = entries.filter((entry) => entry.basis === 'required');
  const consent = entries.filter((entry) => entry.basis !== 'required');
  // Only what is new or changed is asked again; if nothing is marked, the whole list is shown.
  const open = consent.filter((entry) => !entry.current);
  const asked = open.length ? open : consent;

  const save = useMutation({
    mutationFn: () =>
      answerOwnNotificationConsents({
        answers: asked.map((entry) => ({ categoryId: entry.categoryId, granted: granted[entry.categoryId] === true })),
        place: 'app',
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: myNotificationKeys.all });
      await queryClient.invalidateQueries({ queryKey: authQueryKey });
    },
  });

  return (
    <div className="mn-gate">
      <Tile className="mn-gate__card">
        <span className="mn-gate__eyebrow">Before you start</span>
        <h1 ref={heading} tabIndex={-1}>
          Which messages may we send you?
        </h1>
        <p className="mn-gate__lead">
          Hi {currentUser.person.firstName}. We always send what you need to use the makerspace safely. Everything else
          only if you say yes. You can change this any time under <strong>My notifications</strong> in the profile menu,
          top right.
        </p>
        <LegalLinks />
        {settings.isError ? (
          <ErrorState message="The questions could not be loaded." onRetry={() => void settings.refetch()} />
        ) : !settings.data ? (
          <InlineLoading description="Loading" status="active" />
        ) : (
          <>
            {required.map((entry) => (
              <div key={entry.categoryId} className="mn-gate__required">
                <Locked size={20} />
                <div>
                  <strong>{entry.name}</strong> <span className="mn-sub">· always on</span>
                  <p>{entry.description}</p>
                </div>
              </div>
            ))}
            <div className="mn-gate__options">
              {asked.map((entry) => (
                <div key={entry.categoryId} className="mn-gate__option">
                  <Toggle
                    id={`mn-gate-${entry.categoryId}`}
                    labelText={entry.name}
                    labelA="No"
                    labelB="Yes"
                    aria-describedby={`mn-gate-${entry.categoryId}-text`}
                    toggled={granted[entry.categoryId] === true}
                    onToggle={(next) => setGranted((previous) => ({ ...previous, [entry.categoryId]: next }))}
                  />
                  <p id={`mn-gate-${entry.categoryId}-text`}>{entry.description}</p>
                </div>
              ))}
            </div>
            {save.isError && (
              <InlineNotification
                kind="error"
                lowContrast
                hideCloseButton
                title="Your answers were not saved"
                subtitle="Check the connection and try again."
              />
            )}
            <div className="mn-gate__footer">
              <span className="mn-sub">
                Nothing is preselected, and you can use everything in the app whatever you choose.
              </span>
              <Button kind="primary" disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? 'Saving…' : 'Save and continue'}
              </Button>
            </div>
          </>
        )}
      </Tile>
    </div>
  );
}
