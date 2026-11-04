import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { useLatestCallback } from '../../app/useLatestCallback';
import { useCurrentUser } from '../auth/auth';
import { enterDemoMode, exitDemoMode, useDemoMode } from '../demo/demoMode';
import { GuideStepView } from './GuideStepView';
import { guideProgressKey, recordGuideProgress } from './progress';
import { loadGuides } from './registry';
import type { GuideDefinition, GuideStep } from './types';
import type { GuideProgressList } from '../../api/generated/models';

interface Loaded {
  definition: GuideDefinition;
  steps: GuideStep[];
}

/** Runs one guide: loads it, enters demo mode when it needs sample data, and walks through the steps. */
export default function GuideRunner({ guideId, onClose }: { guideId: string; onClose: () => void }) {
  const currentUser = useCurrentUser();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const demoActive = useDemoMode();
  const [origin] = useState(() => `${pathname}${search}`);
  const [previousFocus] = useState(() => document.activeElement);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [index, setIndex] = useState(0);
  const enteredDemo = useRef(false);
  const finishing = useRef(false);

  const user = useLatestCallback(() => currentUser);
  const close = useLatestCallback(onClose);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const definition = (await loadGuides()).find((guide) => guide.id === guideId);
      if (cancelled) return;
      const person = user();
      const steps = definition?.requires(person)
        ? definition.steps.filter((step) => step.requires?.(person) ?? true)
        : [];
      if (!definition || steps.length === 0) {
        close();
        return;
      }
      if (definition.demo) {
        await enterDemoMode(person);
        if (cancelled) {
          await exitDemoMode();
          return;
        }
        enteredDemo.current = true;
      }
      setLoaded({ definition, steps });
    })();
    return () => {
      cancelled = true;
      // Stopped from outside (or unmounted): leave demo mode so sample data never lingers.
      if (enteredDemo.current) {
        enteredDemo.current = false;
        void exitDemoMode();
      }
    };
  }, [guideId, user, close]);

  useEffect(
    () => () => {
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus();
    },
    [previousFocus],
  );

  // "Leave demo" in the banner ends a workflow guide.
  const isDemoGuide = loaded?.definition.demo === true;
  useEffect(() => {
    if (isDemoGuide && !demoActive && !finishing.current) {
      enteredDemo.current = false;
      close();
    }
  }, [isDemoGuide, demoActive, close]);

  const step = loaded?.steps[index];
  useEffect(() => {
    if (step?.route && step.route !== `${pathname}${search}`) void navigate(step.route);
    // Only when the step changes: later navigation is the person's own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  const finish = useLatestCallback(async (completed: boolean) => {
    if (!loaded || finishing.current) return;
    finishing.current = true;
    if (loaded.definition.demo) {
      enteredDemo.current = false;
      await exitDemoMode();
      void navigate(origin);
    }
    close();
    if (completed) {
      await recordGuideProgress(queryClient, guideId, 'completed').catch(() => undefined);
    } else if (guideId === 'welcome') {
      // Closing the welcome tour early counts as "not now"; a finished one stays finished.
      const known = queryClient.getQueryData<GuideProgressList>(guideProgressKey);
      if (!known?.items.some((item) => item.guideId === guideId)) {
        await recordGuideProgress(queryClient, guideId, 'dismissed').catch(() => undefined);
      }
    }
  });

  const next = useLatestCallback(() => {
    if (!loaded) return;
    if (index >= loaded.steps.length - 1) void finish(true);
    else setIndex(index + 1);
  });
  const back = useLatestCallback(() => setIndex((current) => Math.max(0, current - 1)));

  const advance = step?.advance;
  useEffect(() => {
    if (advance?.kind === 'route' && advance.pattern.test(pathname)) next();
  }, [advance, pathname, next]);

  if (!loaded || !step) return null;
  const total = loaded.steps.length;
  return (
    <>
      <div className="guide-live" role="status" aria-live="polite">
        {`Step ${index + 1} of ${total}: ${step.title}`}
      </div>
      <GuideStepView
        key={step.id}
        step={step}
        index={index}
        total={total}
        onBack={back}
        onNext={next}
        onClose={() => void finish(false)}
      />
    </>
  );
}
