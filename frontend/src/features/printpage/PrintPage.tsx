import { Button, InlineLoading, Tile } from '@carbon/react';
import { Download, Logout } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router-dom';
import {
  getDownloadPrintPageFileUrl,
  getDownloadPrintPageTimelapseUrl,
  getGetPrintPagePreviewUrl,
} from '../../api/generated/print-pages/print-pages';
import type { PrintPage as PrintPageData } from '../../api/generated/models';
import { ApiError } from '../../api/http-client';
import { BrandMark } from '../../app/BrandMark';
import { formatDate } from '../../app/dateTime';
import { ErrorState, FullPageLoading } from '../../app/PageState';
import { useCurrentUser, useLogout } from '../auth/auth';
import { useBranding, usePageTitle } from '../branding/branding';
import { PrintPreview } from '../machinelogbook/recording/PrintPreview';
import { formatFileSize, previewLabel } from '../machinelogbook/recording/recordingText';
import type { Thumbnail } from '../machinelogbook/recording/thumbnails';
import { formatDateTime, formatDuration } from '../machinelogbook/shared/format';
import { OutcomeTag } from '../machinelogbook/shared/status';
import { printPageQuery } from './queries';
import './printPage.scss';

/**
 * The page behind the "your timelapse is ready" link: one finished print, centred around its timelapse. It sits
 * outside the application shell, needs a session, and never shows material, price, operator or recipient — the API
 * does not send them. Anyone who may not see the print gets the same "not available" view as for an unknown one.
 */
export default function PrintPage() {
  const { runId = '' } = useParams();
  const query = useQuery(printPageQuery(runId));
  const notAvailable = query.error instanceof ApiError && query.error.status === 404;
  usePageTitle(query.data?.title ?? 'Print');

  return (
    <div className="print-page">
      <PageHeader />
      {query.isPending ? (
        <FullPageLoading label="Loading the print" />
      ) : notAvailable ? (
        <main className="print-page__main">
          <NotAvailable runId={runId} />
        </main>
      ) : query.isError ? (
        <main className="print-page__main">
          <ErrorState
            title="Unable to load this print"
            message="Check the connection and try again."
            onRetry={() => void query.refetch()}
          />
        </main>
      ) : (
        <PrintContent page={query.data} />
      )}
    </div>
  );
}

function PageHeader() {
  const branding = useBranding();
  const currentUser = useCurrentUser();
  const logout = useLogout();
  return (
    <header className="print-page__header">
      <div className="print-page__brand">
        <BrandMark className="print-page__logo" />
        <span className="print-page__brand-name">{branding.identity.displayName}</span>
      </div>
      <div className="print-page__who">
        <span className="print-page__who-name">
          {currentUser.person.firstName} {currentUser.person.lastName}
        </span>
        <Button kind="ghost" size="sm" renderIcon={Logout} disabled={logout.isPending} onClick={() => logout.mutate()}>
          Sign out
        </Button>
      </div>
    </header>
  );
}

/** The 404 view: no title, no hint whether the print exists. */
function NotAvailable({ runId }: { runId: string }) {
  usePageTitle('Print not available');
  // After signing out, the next sign-in comes back here, so the right account can open the link.
  const logout = useLogout(`/prints/${runId}`);
  return (
    <section className="print-page__unavailable">
      <h1>This print isn&apos;t available to you</h1>
      <p>
        It may have been deleted, or the link was meant for someone else. If you think this is wrong, ask a supervisor
        during an open day.
      </p>
      <Button kind="tertiary" disabled={logout.isPending} onClick={() => logout.mutate()}>
        Sign in with another account
      </Button>
    </section>
  );
}

function PrintContent({ page }: { page: PrintPageData }) {
  const { timelapse, artifact } = page;
  const thumbnails = thumbnailsOf(page);
  const timelapseUrl = getDownloadPrintPageTimelapseUrl(page.runId);
  const fileUrl = getDownloadPrintPageFileUrl(page.runId);
  const when = page.endedAt
    ? `finished ${formatDate(page.endedAt)}`
    : `started ${formatDate(page.startedAt)}, still printing`;
  const status = page.timelapseStatus?.state;
  const preview = (
    <Tile>
      <h2 className="print-page__heading">Preview</h2>
      <PrintPreview thumbnails={thumbnails} emptyText="The print file contains no preview image." />
    </Tile>
  );
  const aside = (
    <div className="print-page__aside">
      <Tile>
        <h2 className="print-page__heading">Downloads</h2>
        {timelapse || artifact ? (
          <ul className="print-page__downloads">
            {timelapse && <DownloadRow href={timelapseUrl} label="Timelapse (MP4)" size={timelapse.sizeBytes} />}
            {artifact && <DownloadRow href={fileUrl} label={artifact.originalFileName} size={artifact.sizeBytes} />}
          </ul>
        ) : (
          <p className="print-page__secondary">Nothing to download for this print.</p>
        )}
      </Tile>
      <Tile>
        <h2 className="print-page__heading">About this print</h2>
        <dl className="print-page__facts">
          <dt>Printer</dt>
          <dd>{page.machineName}</dd>
          <dt>Print time</dt>
          <dd>{page.durationSeconds != null ? formatDuration(page.durationSeconds) : 'Still printing'}</dd>
          <dt>Started</dt>
          <dd>{formatDateTime(page.startedAt)}</dd>
          <dt>Finished</dt>
          <dd>{page.endedAt ? formatDateTime(page.endedAt) : '—'}</dd>
        </dl>
      </Tile>
    </div>
  );

  return (
    <main className="print-page__main">
      <div className="print-page__intro">
        <div>
          <p className="print-page__eyebrow">
            {page.viewerIsStaff ? 'Print' : 'Your print'} · {when}
          </p>
          <h1 className="print-page__title">
            {page.title}
            {page.outcome && <OutcomeTag outcome={page.outcome} />}
          </h1>
        </div>
        {timelapse && (
          <Button renderIcon={Download} href={timelapseUrl}>
            Download timelapse
          </Button>
        )}
      </div>

      {timelapse ? (
        <div className="print-page__stage">
          {/* The printer's timelapse has no audio or speech, so there is nothing to caption. */}
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- silent video */}
          <video
            className="print-page__video"
            controls
            preload="metadata"
            src={timelapseUrl}
            aria-label={`Timelapse of ${page.title}`}
          />
        </div>
      ) : status === 'pending' ? (
        <div className="print-page__stage print-page__stage--message">
          <InlineLoading description="The timelapse is on its way" status="active" />
          <p className="print-page__secondary">It appears here as soon as the printer has handed it over.</p>
        </div>
      ) : status === 'expired' ? (
        <div className="print-page__stage print-page__stage--message">
          <p className="print-page__stage-title">The timelapse was deleted</p>
          <p className="print-page__secondary">Timelapses are removed after their retention period.</p>
        </div>
      ) : null}

      <div className={`print-page__lower${timelapse ? '' : ' print-page__lower--cards'}`}>
        {timelapse ? (
          <>
            {preview}
            {aside}
          </>
        ) : (
          <>
            {preview}
            {aside}
          </>
        )}
      </div>

      {timelapse?.expiresAt && (
        <p className="print-page__footnote">
          The timelapse is kept until {formatDate(timelapse.expiresAt)}. Download it if you want to keep it longer.
        </p>
      )}
    </main>
  );
}

// The API answers with Content-Disposition: attachment, so a plain link downloads the file.
function DownloadRow({ href, label, size }: { href: string; label: string; size: number }) {
  return (
    <li className="print-page__download">
      <span className="print-page__download-text">
        <span>{label}</span>
        <span className="print-page__secondary">{formatFileSize(size)}</span>
      </span>
      <Button
        kind="ghost"
        size="sm"
        hasIconOnly
        renderIcon={Download}
        iconDescription={`Download ${label}`}
        tooltipPosition="left"
        href={href}
      />
    </li>
  );
}

/** The print file's images, the primary one first. */
function thumbnailsOf(page: PrintPageData): Thumbnail[] {
  const fileName = page.artifact?.originalFileName ?? page.title;
  return [...page.previews]
    .sort((a, b) => Number(b.primary) - Number(a.primary))
    .map((preview) => ({
      id: preview.id,
      src: getGetPrintPagePreviewUrl(page.runId, preview.id),
      label: previewLabel(preview),
      fileName,
    }));
}
