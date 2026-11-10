import type { SignageWebEmbed } from '../../api/generated/models';
import { aspectLabel, pluralize, relativeTime } from './helpers';

/** The API accepts 1 to 20 allowed websites per embed. */
export const MAX_ORIGINS = 20;

const ORIGIN_ERROR = 'Enter an https address without a path, for example https://example.org';

/**
 * The origin a typed address stands for (`https://host[:port]`, lower case), or null when it is not one: https only,
 * no path, query, fragment, user name or wildcard. A trailing slash is accepted.
 */
export function normalizeOrigin(text: string): string | null {
  const value = text.trim();
  if (value === '' || value.includes('*')) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || value.endsWith('#'))
    return null;
  if (url.pathname !== '/' || value.endsWith('?')) return null;
  return url.origin;
}

/** Checks a website a person wants to add; the message when it cannot be added. */
export function originProblem(text: string, existing: readonly string[]): string | null {
  const origin = normalizeOrigin(text);
  if (origin === null) return ORIGIN_ERROR;
  if (existing.includes(origin)) return 'This website is already in the list.';
  if (existing.length >= MAX_ORIGINS) return `An embed can have at most ${MAX_ORIGINS} websites.`;
  return null;
}

/** The last website cannot be removed: an embed without one would be shown nowhere. Turn the embed off instead. */
export const canRemoveOrigin = (origins: readonly string[]) => origins.length > 1;

/** "fachschaft-muster.example" for an origin; the origin itself when it does not parse. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/** The iframe a website pastes into its HTML. The ratio makes the frame keep its shape at any width. */
export function embedSnippet(embed: Pick<SignageWebEmbed, 'embedUrl' | 'aspectRatio'>): string {
  const ratio = aspectLabel(embed.aspectRatio).replace(':', '/');
  return [
    '<iframe',
    `  src="${embed.embedUrl}"`,
    '  title="Makerspace screen"',
    `  style="width:100%;aspect-ratio:${ratio};border:0"`,
    '  loading="lazy"',
    '  referrerpolicy="strict-origin"></iframe>',
  ].join('\n');
}

export const lastLoaded = (embed: Pick<SignageWebEmbed, 'lastLoadedAt'>, now: number) =>
  embed.lastLoadedAt ? `Last loaded ${relativeTime(embed.lastLoadedAt, now)}` : 'Not loaded yet';

/** "3 displays · 1 web embed": the members of a group, counted by kind. */
export function memberSummary(displays: number, embeds: number): string {
  const parts = [pluralize(displays, 'display')];
  if (embeds > 0) parts.push(pluralize(embeds, 'web embed'));
  return parts.join(' · ');
}
