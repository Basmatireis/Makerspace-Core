import { useEffect, useState } from 'react';
import { useLatestCallback } from '../../../app/useLatestCallback';

const idleTimeoutSeconds = 45;

// A shared tablet must not keep a half-entered PIN or email on screen after the person walked away.
export function useIdleCountdown(onTimeout: () => void, seconds = idleTimeoutSeconds) {
  const [left, setLeft] = useState(seconds);
  const timeout = useLatestCallback(onTimeout);
  useEffect(() => {
    const resetTimer = () => setLeft(seconds);
    window.addEventListener('pointerdown', resetTimer);
    window.addEventListener('keydown', resetTimer);
    const timer = window.setInterval(() => setLeft((current) => current - 1), 1000);
    return () => {
      window.removeEventListener('pointerdown', resetTimer);
      window.removeEventListener('keydown', resetTimer);
      window.clearInterval(timer);
    };
  }, [seconds]);
  useEffect(() => {
    if (left <= 0) timeout();
  }, [left, timeout]);
  return left;
}

/** Counts down once per second and calls onDone at zero (the result screen returns to the start screen). */
export function useReturnCountdown(seconds: number, onDone: () => void, paused = false) {
  const [left, setLeft] = useState(seconds);
  const done = useLatestCallback(onDone);
  useEffect(() => {
    if (paused) return undefined;
    const timer = window.setInterval(() => setLeft((current) => current - 1), 1000);
    return () => window.clearInterval(timer);
  }, [paused]);
  useEffect(() => {
    if (left <= 0) done();
  }, [left, done]);
  return Math.max(left, 0);
}
