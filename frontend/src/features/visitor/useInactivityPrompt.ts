import { useCallback, useEffect, useState } from 'react';
import { useLatestCallback } from '../../app/useLatestCallback';

/**
 * Detects an abandoned shared tablet: after `idleSeconds` without interaction `prompting` turns true and a further
 * `graceSeconds` count down before `onTimeout` runs. `confirm` (the visitor is still there) restarts the idle period.
 * Activity while the prompt is open is deliberately ignored; only an explicit confirmation counts.
 */
export function useInactivityPrompt({
  idleSeconds,
  graceSeconds,
  enabled = true,
  onTimeout,
}: {
  idleSeconds: number;
  graceSeconds: number;
  enabled?: boolean;
  onTimeout: () => void;
}) {
  const [elapsed, setElapsed] = useState(0);
  const timeout = useLatestCallback(onTimeout);
  const prompting = elapsed >= idleSeconds;
  const secondsLeft = Math.max(idleSeconds + graceSeconds - elapsed, 0);

  useEffect(() => {
    if (!enabled) return;
    const onActivity = () => {
      setElapsed((current) => (current >= idleSeconds ? current : 0));
    };
    const events = ['pointerdown', 'keydown', 'input', 'scroll', 'wheel', 'touchmove'] as const;
    events.forEach((name) => window.addEventListener(name, onActivity, true));
    const timer = window.setInterval(() => setElapsed((current) => current + 1), 1000);
    return () => {
      events.forEach((name) => window.removeEventListener(name, onActivity, true));
      window.clearInterval(timer);
    };
  }, [enabled, idleSeconds]);

  useEffect(() => {
    if (enabled && elapsed >= idleSeconds + graceSeconds) timeout();
  }, [enabled, elapsed, idleSeconds, graceSeconds, timeout]);

  const confirm = useCallback(() => setElapsed(0), []);
  return { prompting: enabled && prompting, secondsLeft, confirm };
}
