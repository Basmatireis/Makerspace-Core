import { Email, Notification, Screen, TabletLandscape } from '@carbon/icons-react';
import type { ComponentType } from 'react';

export const channelIcons: Record<string, ComponentType<{ size?: number | string }>> = {
  in_app: Notification,
  email: Email,
  signage: Screen,
  tablet: TabletLandscape,
};
