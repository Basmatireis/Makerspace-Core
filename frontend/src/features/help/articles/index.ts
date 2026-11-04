import type { GuideArea, GuideRequirement } from '../../guides/types';

export interface HelpArticle {
  id: string;
  area: GuideArea;
  title: string;
  summary: string;
  requires: GuideRequirement;
  /** Guides the article offers to start. */
  relatedGuides?: string[];
  /** The Markdown body; a separate chunk per article. */
  load: () => Promise<string>;
}

/** Every help article. Other areas add their articles here; the help center hides areas without any. */
export const articles: HelpArticle[] = [
  {
    id: 'getting-started',
    area: 'getting-started',
    title: 'Getting started',
    summary: 'The navigation, the header actions and the dashboard.',
    requires: () => true,
    relatedGuides: ['welcome'],
    load: () => import('./getting-started.md?raw').then((module) => module.default),
  },
  {
    id: 'help-and-tours',
    area: 'getting-started',
    title: 'Help, tours and demos',
    summary: 'How guided tours and workflow demos work, and how to start them again.',
    requires: () => true,
    relatedGuides: ['welcome'],
    load: () => import('./help-and-tours.md?raw').then((module) => module.default),
  },
];
