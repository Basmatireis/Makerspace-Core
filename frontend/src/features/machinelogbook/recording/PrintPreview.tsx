import { useState, type KeyboardEvent } from 'react';
import { Button, IconButton, Tag } from '@carbon/react';
import { ChevronLeft, ChevronRight, Download, NoImage } from '@carbon/icons-react';
import type { Thumbnail } from './thumbnails';
import './recording.scss';

/**
 * Large preview of the print file's embedded images. With several images a strip of small previews sits below it;
 * arrow keys and the chevrons step through them. The tile also offers the print file of the shown image.
 */
export function PrintPreview({
  thumbnails,
  emptyText,
  emptyDownload,
}: {
  thumbnails: Thumbnail[];
  emptyText: string;
  /** Print file to offer when there is a file but no preview image. */
  emptyDownload?: { href: string; fileName: string };
}) {
  const [index, setIndex] = useState(0);
  const current = thumbnails[Math.min(index, thumbnails.length - 1)];

  if (!current) {
    return (
      <div className="print-preview">
        <div className="print-preview__stage print-preview__stage--empty">
          <NoImage size={48} aria-hidden />
          <p>{emptyText}</p>
        </div>
        {emptyDownload && (
          <Button
            className="print-preview__download"
            kind="tertiary"
            size="sm"
            renderIcon={Download}
            href={emptyDownload.href}
          >
            Download {emptyDownload.fileName}
          </Button>
        )}
      </div>
    );
  }

  const many = thumbnails.length > 1;
  const step = (delta: number) => setIndex((value) => (value + delta + thumbnails.length) % thumbnails.length);
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowLeft') step(-1);
    if (event.key === 'ArrowRight') step(1);
  };

  return (
    // The wrapper only forwards arrow keys from the chevrons and thumbnails inside it, which are the focusable controls.
    <div className="print-preview" onKeyDown={many ? onKeyDown : undefined}>
      <div className="print-preview__stage">
        <img src={current.src} alt={`${current.label} preview of ${current.fileName}`} />
        {many && (
          <>
            <span className="print-preview__nav print-preview__nav--prev">
              <IconButton kind="ghost" size="sm" label="Previous preview" onClick={() => step(-1)}>
                <ChevronLeft />
              </IconButton>
            </span>
            <span className="print-preview__nav print-preview__nav--next">
              <IconButton kind="ghost" size="sm" label="Next preview" onClick={() => step(1)}>
                <ChevronRight />
              </IconButton>
            </span>
          </>
        )}
      </div>
      <div className="print-preview__caption">
        <span>
          <strong>{current.label}</strong>
          <span className="mj-secondary">
            {' · '}
            {current.fileName}
          </span>
        </span>
        {current.runDisplayId && (
          <Tag size="sm" type="gray">
            {current.runDisplayId}
          </Tag>
        )}
      </div>
      {many && (
        <div className="print-preview__strip" role="group" aria-label="Previews">
          {thumbnails.map((thumbnail, i) => (
            <button
              key={`${thumbnail.runDisplayId ?? ''}-${thumbnail.id}`}
              type="button"
              className="print-preview__thumb"
              aria-pressed={i === index}
              aria-label={`${thumbnail.label}${thumbnail.runDisplayId ? ` (${thumbnail.runDisplayId})` : ''}`}
              onClick={() => setIndex(i)}
            >
              <img src={thumbnail.src} alt="" />
            </button>
          ))}
        </div>
      )}
      {current.downloadHref && (
        <Button
          className="print-preview__download"
          kind="tertiary"
          size="sm"
          renderIcon={Download}
          href={current.downloadHref}
        >
          Download {current.fileName}
        </Button>
      )}
    </div>
  );
}
