/* eslint-disable react-refresh/only-export-components -- the card and its slide helpers belong together */
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import { Button, IconButton, Tag } from '@carbon/react';
import {
  ChevronLeft,
  ChevronRight,
  Close,
  Download,
  Launch,
  Link as LinkIcon,
  NoImage,
  Play,
} from '@carbon/icons-react';
import {
  getDownloadMachineRunArtifactUrl,
  getDownloadMachineRunTimelapseUrl,
  getGetMachineRunPreviewUrl,
} from '../../../api/generated/machine-runs/machine-runs';
import type { MachineRunRecording } from '../../../api/generated/models';
import { StackCard } from '../../../app/components/CardList';
import { formatDate } from '../../../app/dateTime';
import { useNotify } from '../../../app/toasts';
import { copyToClipboard } from '../../profile/copyToClipboard';
import { formatFileSize, timelapseMessage } from '../recording/recordingText';
import { plateImages } from '../recording/thumbnails';
import '../styles/jobs.scss';
import './jobs.scss';

type Slide = { kind: 'file' | 'timelapse'; recording: MachineRunRecording };

/** Print file and timelapse of every recorded run, newest run first. */
export function slidesOf(recordings: MachineRunRecording[]): Slide[] {
  return [...recordings]
    .filter((recording) => recording.source === 'recorded')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .flatMap((recording) => {
      const slides: Slide[] = [{ kind: 'file', recording }];
      if (recording.timelapse || (recording.timelapseStatus && recording.timelapseStatus.state !== 'not_found'))
        slides.push({ kind: 'timelapse', recording });
      return slides;
    });
}

function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="jobs-media__empty">
      <NoImage size={32} aria-hidden="true" />
      <span>{title}</span>
      {detail && <small>{detail}</small>}
    </div>
  );
}

function Stage({ slide }: { slide: Slide }) {
  const { recording } = slide;
  if (slide.kind === 'file') {
    const image = plateImages(recording.previews)[0];
    if (image)
      return (
        <img
          className="jobs-media__image"
          src={getGetMachineRunPreviewUrl(recording.runId, image.id)}
          alt={`Preview of ${recording.artifact?.originalFilename ?? recording.runDisplayId}`}
        />
      );
    return recording.artifact ? (
      <Empty title="No preview in the print file" />
    ) : (
      <Empty title="Print file not stored" detail="Recorded runs bring their 3MF here." />
    );
  }
  if (recording.timelapse)
    return (
      // The printer's timelapse has no audio or speech, so there is nothing to caption.
      // eslint-disable-next-line jsx-a11y/media-has-caption -- silent video
      <video
        className="jobs-media__video"
        controls
        preload="none"
        src={getDownloadMachineRunTimelapseUrl(recording.runId)}
        aria-label={`Timelapse of ${recording.runDisplayId}`}
      />
    );
  const message = timelapseMessage(recording.timelapseStatus);
  return <Empty title={message?.title ?? 'No timelapse'} detail={message?.message} />;
}

/** The fixed two-row caption: file or download left and size right, then run id left and retention right. */
function Caption({ slide }: { slide: Slide }) {
  const { recording } = slide;
  let left: ReactNode;
  let right: ReactNode;
  let keptUntil: string | null = null;
  if (slide.kind === 'file') {
    const file = recording.artifact;
    left = file ? (
      <Button
        kind="ghost"
        size="sm"
        className="jobs-media__download"
        renderIcon={Download}
        href={getDownloadMachineRunArtifactUrl(recording.runId)}
        title={`Download ${file.originalFilename}`}
      >
        <span className="jobs-media__file">{file.originalFilename}</span>
      </Button>
    ) : (
      <span className="jobs-media__file mj-secondary">No print file</span>
    );
    right = file ? <span className="mj-secondary">{formatFileSize(file.sizeBytes)}</span> : null;
  } else {
    const video = recording.timelapse;
    const name = `${recording.runDisplayId}-timelapse.mp4`;
    left = video ? (
      <Button
        kind="ghost"
        size="sm"
        className="jobs-media__download"
        renderIcon={Download}
        href={getDownloadMachineRunTimelapseUrl(recording.runId)}
        title="Download the timelapse"
      >
        <span className="jobs-media__file">{name}</span>
      </Button>
    ) : (
      <span className="jobs-media__file mj-secondary">{name}</span>
    );
    right = video ? <span className="mj-secondary">{formatFileSize(video.sizeBytes)}</span> : null;
    keptUntil = video?.expiresAt ? `kept until ${formatDate(video.expiresAt)}` : null;
  }
  return (
    <figcaption className="jobs-media__caption">
      <span className="jobs-media__row">
        <span className="jobs-media__left">{left}</span>
        <span className="jobs-media__right">{right}</span>
      </span>
      <span className="jobs-media__row jobs-media__row--sub">
        <span className="jobs-media__left">{recording.runDisplayId}</span>
        <span className="jobs-media__right">{keptUntil}</span>
      </span>
    </figcaption>
  );
}

export interface MediaCardProps {
  recordings: MachineRunRecording[];
  /** The job's signage flag; with `onToggleSignage` the title row offers the toggle, else an "Off signage" tag. */
  offSignage: boolean;
  onToggleSignage?: () => void;
  signagePending?: boolean;
  /** The recorded run whose print page the card links to; omitted for runs without a job. */
  printPageRunId?: string;
}

/** Opens the run's print page (the page its recipient gets by notification) or copies its link. */
export function PrintPageActions({ runId }: { runId: string }) {
  const notify = useNotify();
  const path = `/prints/${runId}`;
  const copy = async () => {
    const copied = await copyToClipboard(`${window.location.origin}${path}`);
    notify(
      copied
        ? { kind: 'success', title: 'Link copied', subtitle: 'Anyone who may see this print can open it.' }
        : { kind: 'error', title: 'Link not copied', subtitle: 'Copy the address of the print page by hand.' },
    );
  };
  return (
    <div className="jobs-media__page-actions">
      <Button kind="ghost" size="sm" renderIcon={Launch} href={path} target="_blank" rel="noopener noreferrer">
        Open print page<span className="cds--visually-hidden"> (opens in a new tab)</span>
      </Button>
      <Button kind="ghost" size="sm" renderIcon={LinkIcon} onClick={() => void copy()}>
        Copy link
      </Button>
    </div>
  );
}

/** The job's signage toggle, or an "Off signage" tag for people who may not change it. */
export function SignageToggle({
  offSignage,
  onToggleSignage,
  signagePending,
}: Pick<MediaCardProps, 'offSignage' | 'onToggleSignage' | 'signagePending'>) {
  return onToggleSignage ? (
    <Button
      kind="ghost"
      size="sm"
      renderIcon={offSignage ? Close : Play}
      disabled={signagePending}
      title={
        offSignage
          ? 'Stream and timelapses of this job are hidden from every signage display'
          : 'Stream and timelapses of this job can appear on the signage displays'
      }
      onClick={onToggleSignage}
    >
      {offSignage ? 'Off signage' : 'On signage'}
    </Button>
  ) : offSignage ? (
    <Tag type="outline" size="sm">
      Off signage
    </Tag>
  ) : null;
}

/** A slideshow over 3MF previews and timelapses, with arrows and dots and a fixed two-row caption. */
export function MediaSlides({ recordings }: { recordings: MachineRunRecording[] }) {
  const slides = slidesOf(recordings);
  const [index, setIndex] = useState(0);
  const current = slides[Math.min(index, slides.length - 1)];
  const step = (delta: number) => setIndex((value) => (value + delta + slides.length) % slides.length);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  };
  return (
    <>
      {slides.length > 1 && (
        <p className="jobs-media__count mj-secondary" aria-live="polite">
          {index + 1} / {slides.length}
        </p>
      )}
      {!current ? (
        <figure className="jobs-media__figure">
          <div className="jobs-media__stage">
            <Empty title="No print file yet" detail="Recorded runs bring their 3MF and timelapse here." />
          </div>
        </figure>
      ) : (
        <figure className="jobs-media__figure" onKeyDown={slides.length > 1 ? onKeyDown : undefined}>
          <div className="jobs-media__stage">
            <Stage slide={current} />
            <span className="jobs-media__type">{current.kind === 'file' ? 'Print file' : 'Timelapse'}</span>
            {slides.length > 1 && (
              <div className="jobs-media__controls">
                <IconButton kind="ghost" size="sm" label="Previous" onClick={() => step(-1)}>
                  <ChevronLeft />
                </IconButton>
                <span className="jobs-media__dots" role="group" aria-label="Slides">
                  {slides.map((slide, i) => (
                    <button
                      key={`${slide.recording.runId}-${slide.kind}`}
                      type="button"
                      className="jobs-media__dot"
                      aria-pressed={i === index}
                      aria-label={`${slide.kind === 'file' ? 'Print file' : 'Timelapse'} of ${slide.recording.runDisplayId}`}
                      title={`${slide.kind === 'file' ? 'Print file' : 'Timelapse'} · ${slide.recording.runDisplayId}`}
                      onClick={() => setIndex(i)}
                    />
                  ))}
                </span>
                <IconButton kind="ghost" size="sm" label="Next" onClick={() => step(1)}>
                  <ChevronRight />
                </IconButton>
              </div>
            )}
          </div>
          <Caption slide={current} />
        </figure>
      )}
    </>
  );
}

/**
 * "Print files & timelapses": the slideshow over the 3MF previews and timelapses of the runs, with the job's signage
 * toggle in the title row.
 */
export function MediaCard({ recordings, offSignage, onToggleSignage, signagePending, printPageRunId }: MediaCardProps) {
  const toggle = (
    <SignageToggle offSignage={offSignage} onToggleSignage={onToggleSignage} signagePending={signagePending} />
  );
  return (
    <StackCard
      title="Print files & timelapses"
      action={onToggleSignage || offSignage ? toggle : undefined}
      className="jobs-media"
    >
      <MediaSlides recordings={recordings} />
      {printPageRunId && <PrintPageActions runId={printPageRunId} />}
    </StackCard>
  );
}

/** The newest print file preview of the runs, for a detail panel; an empty stage without one. */
export function PanelPreview({ recordings }: { recordings: MachineRunRecording[] }) {
  const slide = slidesOf(recordings).find((item) => item.kind === 'file');
  return (
    <figure className="jobs-media__figure jobs-panel__preview">
      <div className="jobs-media__stage">{slide ? <Stage slide={slide} /> : <Empty title="No preview" />}</div>
      {slide && <Caption slide={slide} />}
    </figure>
  );
}
