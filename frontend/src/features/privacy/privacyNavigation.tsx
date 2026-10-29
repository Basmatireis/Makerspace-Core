/* eslint-disable react-refresh/only-export-components -- the section catalog, its paths and the link form one module */
import { Link as CarbonLink } from '@carbon/react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/** The sections of the privacy area: the categories page is the entry, the others are its sub-pages. */
export type PrivacySection = 'categories' | 'holds' | 'runs' | 'requests' | 'activities' | 'settings';

export const privacyBasePath = '/settings/privacy';

export const privacySections: Record<PrivacySection, { title: string; description: string }> = {
  categories: {
    title: 'Privacy & data retention',
    description: "Data categories, retention and the installation's privacy settings.",
  },
  holds: {
    title: 'Holds',
    description: 'What retention must leave alone for now: a whole category, or one person who must not be erased yet.',
  },
  runs: {
    title: 'Execution history',
    description: 'Every retention run, with what it changed per data category.',
  },
  requests: {
    title: 'Data requests',
    description:
      'People asking for a copy of their data or for erasure. Every request has one month; the page tells you whose move it is.',
  },
  activities: {
    title: 'Processing activities',
    description: 'The record of processing activities: what is processed, why, and on which legal basis.',
  },
  settings: {
    title: 'Settings',
    description: 'Who is responsible for the data, and whether the app runs retention on its own.',
  },
};

/** The path of a section; the categories page is the privacy page itself. */
export function privacyPath(section: PrivacySection): string {
  return section === 'categories' ? privacyBasePath : `${privacyBasePath}/${section}`;
}

/** The path of a category's retention page, where its decision is edited. */
export function categoryRetentionPath(categoryId: string): string {
  return `${privacyBasePath}/categories/${encodeURIComponent(categoryId)}`;
}

/** The category id a retention page's location points to, or null. */
export function categoryIdFromPath(pathname: string): string | null {
  const prefix = `${privacyBasePath}/categories/`;
  if (!pathname.startsWith(prefix)) return null;
  const id = decodeURIComponent(pathname.slice(prefix.length).replace(/\/+$/, ''));
  return id === '' ? null : id;
}

/** The path of one data request's page. */
export function requestPath(requestId: string): string {
  return `${privacyBasePath}/requests/${encodeURIComponent(requestId)}`;
}

/** The request id a request page's location points to, or null. */
export function requestIdFromPath(pathname: string): string | null {
  const prefix = `${privacyBasePath}/requests/`;
  if (!pathname.startsWith(prefix)) return null;
  const id = decodeURIComponent(pathname.slice(prefix.length).replace(/\/+$/, ''));
  return id === '' ? null : id;
}

/** The section a location points to, or null for a path that is not a privacy page. */
export function privacySectionFromPath(pathname: string): PrivacySection | null {
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed === privacyBasePath) return 'categories';
  if (!trimmed.startsWith(`${privacyBasePath}/`)) return null;
  const rest = trimmed.slice(privacyBasePath.length + 1);
  return rest in privacySections && rest !== 'categories' ? (rest as PrivacySection) : null;
}

/** A Carbon link to another section of the privacy area, without a full page load. */
export function PrivacyLink({
  section,
  children,
  size,
}: {
  section: PrivacySection;
  children: ReactNode;
  size?: 'sm' | 'md' | 'lg';
}) {
  return (
    <CarbonLink as={Link} to={privacyPath(section)} size={size}>
      {children}
    </CarbonLink>
  );
}
