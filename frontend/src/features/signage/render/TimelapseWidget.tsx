import { useEffect, useEffectEvent, useState } from 'react';
import type { SignageTimelapseWidget } from '../../../api/generated/models';
import { timelapseCaption, timelapseClips, type Clip } from './timelapseModel';
import type { RenderData } from './types';

// Timelapses of finished prints as a slideshow: newest first, each clip from the start until it ends or `maxSeconds`
// pass, then the next one with a cut or a fade. Lazily loaded like the calendar, so the player's initial bundle stays small.

type Props = { widget: SignageTimelapseWidget; data: RenderData };
/** The clip on screen; `round` changes when the same clip starts again, so its video restarts. */
type Playing = { runId: string; round: number };

export function TimelapseWidget({ widget, data }: Props) {
  const clips = timelapseClips(widget, data);
  const [playing, setPlaying] = useState<Playing | null>(null);
  const index = Math.max(
    0,
    clips.findIndex((clip) => clip.runId === playing?.runId),
  );
  const current = clips[index] as Clip | undefined;
  const round = current && current.runId === playing?.runId ? playing.round : 0;
  const key = current ? `${current.runId}:${round}` : null;
  const still = Boolean(data.still);

  const advance = () => {
    if (clips.length === 0) return;
    const next = clips[(index + 1) % clips.length];
    setPlaying({ runId: next.runId, round: round + 1 });
  };
  const timeUp = useEffectEvent(advance);
  useEffect(() => {
    if (!key || still) return;
    const timer = window.setTimeout(timeUp, widget.maxSeconds * 1000);
    return () => window.clearTimeout(timer);
  }, [key, still, widget.maxSeconds]);

  if (!current) return null;
  const caption = widget.showCaption ? (
    <span className="sg-timelapse__caption">{timelapseCaption(current, data.timeZone)}</span>
  ) : null;
  if (still)
    return (
      <div className="sg-timelapse">
        <video
          className="sg-media"
          src={current.src}
          style={{ objectFit: widget.fit }}
          muted
          playsInline
          preload="metadata"
        />
        {caption}
      </div>
    );
  return (
    <div className={`sg-timelapse${widget.transition === 'fade' ? ' sg-fade' : ''}`} key={key}>
      <video
        className="sg-media"
        src={current.src}
        style={{ objectFit: widget.fit }}
        muted
        autoPlay
        playsInline
        preload="auto"
        onEnded={advance}
      />
      {caption}
    </div>
  );
}
