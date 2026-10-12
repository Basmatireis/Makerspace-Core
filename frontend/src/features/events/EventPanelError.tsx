import { InlineNotification } from '@carbon/react';
import { eventMutationMessage } from './errors';

export function MutationError({ error, title = 'Change not saved' }: { error: unknown; title?: string }) {
  return error ? <InlineNotification kind="error" lowContrast hideCloseButton title={title} subtitle={eventMutationMessage(error)} /> : null;
}
