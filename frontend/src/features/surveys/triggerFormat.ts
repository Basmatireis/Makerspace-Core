import type { Survey } from '../../api/generated/models';

export const maxDelayMinutes = 10080;
export const maxCooldownDays = 3650;

export function formatDelay(seconds: number): string {
  if (seconds === 0) return 'immediately after check-out';
  if (seconds < 60) return `${seconds} s after check-out`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min after check-out`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return `${[days && `${days} d`, hours && `${hours} h`, rest && `${rest} min`].filter(Boolean).join(' ')} after check-out`;
}

export function describeTrigger(trigger: Survey['trigger']): string {
  if (!trigger) return 'No post-visit trigger configured.';
  const days = trigger.cooldownDays === 1 ? '1 day' : `${trigger.cooldownDays} days`;
  const state = trigger.enabled ? 'Sent' : 'Disabled · would be sent';
  return `${state} ${formatDelay(trigger.delaySeconds)} · cooldown ${days}`;
}
