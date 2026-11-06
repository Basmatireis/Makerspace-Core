import {
  AlignBoxMiddleCenter,
  AlignBoxTopCenter,
  AlignBoxTopRight,
  CheckmarkFilled,
  Email,
  ErrorFilled,
  InformationFilled,
  Notification,
  Screen,
  TabletLandscape,
  WarningAltFilled,
} from '@carbon/icons-react';
import type { ComponentType } from 'react';

export const channelIcons: Record<string, ComponentType<{ size?: number | string }>> = {
  in_app: Notification,
  email: Email,
  signage: Screen,
  tablet: TabletLandscape,
};

type IconComponent = ComponentType<{ size?: number | string; className?: string; 'aria-hidden'?: boolean }>;

/** The Carbon status icon of each notification level; its colour comes from the level's support token. */
export const levelIcons: Record<string, IconComponent> = {
  info: InformationFilled,
  success: CheckmarkFilled,
  warning: WarningAltFilled,
  error: ErrorFilled,
};

/** A small icon that shows where on the screen each appearance sits. */
export const appearanceIcons: Record<string, IconComponent> = {
  bell: Notification,
  toast: AlignBoxTopRight,
  banner: AlignBoxTopCenter,
  dialog: AlignBoxMiddleCenter,
};

/** Level values the editor knows; anything else is drawn as info. */
export const levelOf = (level: string | undefined) => (level && level in levelIcons ? level : 'info');
