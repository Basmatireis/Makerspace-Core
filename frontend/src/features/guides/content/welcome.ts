import type { GuideDefinition } from '../types';

export const welcome: GuideDefinition = {
  id: 'welcome',
  area: 'getting-started',
  title: 'Welcome tour',
  summary: 'Find your way around: navigation, notifications, your profile and the help center.',
  duration: '2 min',
  kind: 'tour',
  demo: false,
  requires: () => true,
  steps: [
    {
      id: 'navigation',
      title: 'The side navigation',
      body: 'Everything you can open lives here. The groups follow your permissions, so you only see the areas you can work in.\n\nOn a narrow screen the navigation folds away; open it with the menu button in the top left.',
      route: '/dashboard',
      target: '[data-guide="shell-nav"]',
      placement: 'right',
    },
    {
      id: 'help',
      title: 'Help is always here',
      body: 'This button opens the help center with guided tours, step-by-step demos and articles.',
      target: '[data-guide="header-help"]',
      placement: 'bottom',
    },
    {
      id: 'notifications',
      title: 'Notifications',
      body: 'Messages from the team and reminders show up here. A badge tells you how many you have not read yet.',
      target: '[data-guide="header-notifications"]',
      placement: 'bottom',
    },
    {
      id: 'profile',
      title: 'Your profile menu',
      body: 'Open your profile, switch between the light and dark theme or sign out.',
      target: '[data-guide="header-profile"]',
      placement: 'bottom',
    },
    {
      id: 'dashboard',
      title: 'Your dashboard',
      body: 'The dashboard is your starting point. It shows what is coming up for you and what needs your attention.',
      route: '/dashboard',
      target: '[data-page-shell] .page-header',
      placement: 'bottom',
    },
    {
      id: 'more',
      title: 'Want to see more?',
      body: 'The help center lists tours for the areas you work in. You can start any tour again at any time.',
      route: '/help',
    },
  ],
};
