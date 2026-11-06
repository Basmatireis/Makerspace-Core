import { useState } from 'react';
import {
  Button,
  ComposedModal,
  InlineLoading,
  InlineNotification,
  ModalBody,
  ModalFooter,
  ModalHeader,
  Stack,
  TextInput,
} from '@carbon/react';
import { Copy } from '@carbon/icons-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  createMyCalendarFeed,
  getMyCalendarFeed,
  revokeMyCalendarFeed,
} from '../../api/generated/calendar-feed/calendar-feed';
import { ApiError } from '../../api/http-client';
import { formatDateTime } from '../../app/dateTime';
import { copyToClipboard } from './copyToClipboard';

const calendarFeedKey = ['me', 'calendar-feed'] as const;

type Pending = 'rotate' | 'revoke' | null;

const errorText = (error: unknown) =>
  error instanceof ApiError ? error.message : 'Check the connection and try again.';

/** The link is a path when the server has no public base URL configured. */
const absoluteUrl = (url: string) => new URL(url, window.location.origin).href;

/**
 * The person's private calendar subscription: create the link, copy it, replace it or revoke it. The link is shown
 * once, right after it was created, and lives only in this dialog's state: the server keeps nothing but a digest.
 */
export default function CalendarSubscriptionDialog({ onClose }: { onClose: () => void }) {
  const client = useQueryClient();
  const status = useQuery({
    queryKey: calendarFeedKey,
    queryFn: ({ signal }) => getMyCalendarFeed({ signal }),
  });
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState<'copied' | 'failed' | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const create = useMutation({ mutationFn: () => createMyCalendarFeed() });
  const revoke = useMutation({ mutationFn: () => revokeMyCalendarFeed() });
  const busy = create.isPending || revoke.isPending;
  const active = status.data?.active ?? false;

  const createLink = async () => {
    setPending(null);
    setCopied(null);
    try {
      const created = await create.mutateAsync();
      setLink(absoluteUrl(created.url));
      await client.invalidateQueries({ queryKey: calendarFeedKey });
    } catch {
      // The error shows from the mutation state.
    } finally {
      // The secret is kept in this dialog's state only, not in the mutation cache.
      create.reset();
    }
  };
  const revokeLink = async () => {
    setPending(null);
    setLink(null);
    setCopied(null);
    try {
      await revoke.mutateAsync();
      await client.invalidateQueries({ queryKey: calendarFeedKey });
    } catch {
      // The error shows from the mutation state.
    }
  };
  const copy = async () => {
    if (link) setCopied((await copyToClipboard(link)) ? 'copied' : 'failed');
  };

  return (
    <ComposedModal open onClose={onClose} size="sm" preventCloseOnClickOutside>
      <ModalHeader title="Calendar subscription" closeModal={onClose} />
      <ModalBody>
        <Stack gap={5}>
          <p>
            Subscribe to your open days and event shifts in your calendar app (Apple Calendar, Google Calendar,
            Outlook). The link contains only your own commitments, no other person&apos;s name. Anyone who has the link
            can read them, so keep it private.
          </p>
          {status.isPending && <InlineLoading description="Loading…" />}
          {status.isError && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title="Could not load the subscription"
              subtitle={errorText(status.error)}
            />
          )}
          {(create.isError || revoke.isError) && (
            <InlineNotification
              kind="error"
              lowContrast
              hideCloseButton
              title={create.isError ? 'Link not created' : 'Link not revoked'}
              subtitle={errorText(create.error ?? revoke.error)}
            />
          )}
          {status.data && !active && !link && (
            <>
              <p>You have no calendar subscription yet.</p>
              <div>
                <Button kind="primary" disabled={busy} onClick={() => void createLink()}>
                  {create.isPending ? 'Creating…' : 'Create link'}
                </Button>
              </div>
            </>
          )}
          {link && (
            <>
              <InlineNotification
                kind="success"
                lowContrast
                hideCloseButton
                title="Your link is ready"
                subtitle="Copy it now and add it to your calendar app as a subscription. It is shown only once."
              />
              <TextInput
                id="calendar-feed-link"
                labelText="Subscription link"
                readOnly
                value={link}
                onFocus={(event) => event.target.select()}
              />
              <div>
                <Button kind="secondary" renderIcon={Copy} onClick={() => void copy()}>
                  Copy link
                </Button>
              </div>
              <p role="status">
                {copied === 'copied' && 'Copied to the clipboard.'}
                {copied === 'failed' && 'Copying is not available here. Select the link and copy it by hand.'}
              </p>
            </>
          )}
          {status.data && active && (
            <>
              {!link && (
                <p>
                  Your subscription is active since{' '}
                  {status.data.createdAt ? formatDateTime(status.data.createdAt) : '—'}
                  {status.data.lastUsedAt
                    ? `; a calendar last read it around ${formatDateTime(status.data.lastUsedAt)}`
                    : '; no calendar has read it yet'}
                  . The link itself cannot be shown again. Create a new link if you lost it.
                </p>
              )}
              {pending === null ? (
                <div className="button-cluster">
                  <Button kind="tertiary" disabled={busy} onClick={() => setPending('rotate')}>
                    Create a new link
                  </Button>
                  <Button kind="danger--ghost" disabled={busy} onClick={() => setPending('revoke')}>
                    Revoke subscription
                  </Button>
                </div>
              ) : (
                <>
                  <InlineNotification
                    kind="warning"
                    lowContrast
                    hideCloseButton
                    title={pending === 'rotate' ? 'Replace the link?' : 'Revoke the subscription?'}
                    subtitle={
                      pending === 'rotate'
                        ? 'The old link stops working at once in every calendar that uses it.'
                        : 'Calendars that use the link stop updating. You can create a new link later.'
                    }
                  />
                  <div className="button-cluster">
                    <Button kind="ghost" size="sm" onClick={() => setPending(null)}>
                      Keep it
                    </Button>
                    <Button
                      kind="danger"
                      size="sm"
                      disabled={busy}
                      onClick={() => void (pending === 'rotate' ? createLink() : revokeLink())}
                    >
                      {pending === 'rotate' ? 'Replace link' : 'Revoke'}
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </Stack>
      </ModalBody>
      <ModalFooter>
        <Button kind="secondary" onClick={onClose}>
          Close
        </Button>
      </ModalFooter>
    </ComposedModal>
  );
}
