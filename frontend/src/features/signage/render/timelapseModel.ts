import type { SignageTimelapseWidget } from '../../../api/generated/models';
import { MONTHS, wallTime } from './dates';
import type { RenderData, RenderTimelapse } from './types';

// Which clips a timelapse widget plays and how they are captioned (TimelapseWidget.tsx renders them).

export type Clip = RenderTimelapse & { src: string };

const DAY_MS = 86_400_000;

/** The clips the widget plays, newest first: its machines, ended within `maxAgeDays`, at most `count`, playable now. */
export function timelapseClips(widget: SignageTimelapseWidget, data: RenderData): Clip[] {
  const urlOf = data.timelapseUrl;
  if (!urlOf) return [];
  const machines = widget.source === 'machines' ? new Set(widget.machineIds) : null;
  const oldest = widget.maxAgeDays > 0 ? data.now - widget.maxAgeDays * DAY_MS : -Infinity;
  return (data.timelapses ?? [])
    .filter((clip) => (!machines || machines.has(clip.machineId)) && Date.parse(clip.endedAt) >= oldest)
    .sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt))
    .slice(0, widget.count)
    .flatMap((clip) => {
      // A clip the player has not cached yet is skipped until it is.
      const src = urlOf(clip);
      return src ? [{ ...clip, src }] : [];
    });
}

/** "Prusa MK4 · 23 Oct": the machine and the day the print ended, never the job, file or person. */
export const timelapseCaption = (clip: RenderTimelapse, timeZone?: string) => {
  const ended = wallTime(clip.endedAt, timeZone);
  return `${clip.machineName} · ${ended.day} ${MONTHS[ended.month].slice(0, 3)}`;
};
