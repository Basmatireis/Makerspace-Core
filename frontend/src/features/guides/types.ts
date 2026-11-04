import type { CurrentUser } from '../../api/generated/models';

/** The app areas that have guides and help articles. */
export type GuideArea = 'getting-started' | 'workshop' | 'sales' | 'open-days';

/** Whether a guide, step or article applies to someone, decided from their permissions (UX only). */
export type GuideRequirement = (user: CurrentUser) => boolean;

/** How a step moves on: with the Next button, once the user clicks the target, or once a route matches. */
export type GuideAdvance = { kind: 'next' } | { kind: 'click' } | { kind: 'route'; pattern: RegExp };

export interface GuideStep {
  id: string;
  title: string;
  /** Plain text; blank lines separate paragraphs. */
  body: string;
  /** Navigate here before the step shows (demo guides run against demo data, so ids there are stable). */
  route?: string;
  /** A CSS selector, preferably `[data-guide="…"]`; without one the step shows as a centered dialog. */
  target?: string;
  placement?: 'top' | 'bottom' | 'left' | 'right';
  /** Default `{ kind: 'next' }`. */
  advance?: GuideAdvance;
  /** Skip the step for people it does not apply to. */
  requires?: GuideRequirement;
}

export interface GuideDefinition {
  id: string;
  area: GuideArea;
  title: string;
  summary: string;
  /** Rough length shown in the help center, for example "3 min". */
  duration: string;
  /** `tour` shows where things are; `workflow` walks through a task end to end. */
  kind: 'tour' | 'workflow';
  /** Workflows run in demo mode: sample data in the browser, nothing reaches the server. */
  demo: boolean;
  requires: GuideRequirement;
  steps: GuideStep[];
}
