import { useEffect, useId, useRef } from 'react';
import { Button, ButtonSet, Modal, Popover, PopoverContent } from '@carbon/react';
import { useLatestCallback } from '../../app/useLatestCallback';
import './guides.scss';
import type { GuideStep } from './types';
import { useAppModalOpen, useElementRect, useGuideTarget } from './useGuideTarget';

const NARROW_SHELL_QUERY = '(max-width: 65.98rem)';
const SPOTLIGHT_PADDING = 4;
const OVERSIZED_SHARE = 0.7;
const VIEWPORT_MARGIN = 8;

interface Props {
  step: GuideStep;
  index: number;
  total: number;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function StepContent({
  step,
  index,
  total,
  heading,
  titleId,
  interactive,
  onBack,
  onNext,
  onClose,
}: Props & {
  heading: boolean;
  titleId: string;
  /** The step waits for the person to use the page, so Next is replaced by a hint. */
  interactive: boolean;
}) {
  const last = index === total - 1;
  const hint = step.advance?.kind === 'route' ? 'Continue in the app to move on.' : 'Click the highlighted element.';
  return (
    <div className="guide-panel__body">
      {heading && (
        <h2 id={titleId} className="guide-panel__title">
          {step.title}
        </h2>
      )}
      {step.body.split(/\n\s*\n/).map((paragraph) => (
        <p key={paragraph}>{paragraph}</p>
      ))}
      {interactive && <p className="guide-panel__hint">{hint}</p>}
      <p className="guide-panel__progress">
        Step {index + 1} of {total}
      </p>
      <div className="guide-panel__actions">
        <Button kind="ghost" size="sm" onClick={onClose}>
          Close tour
        </Button>
        <ButtonSet>
          {index > 0 && (
            <Button kind="secondary" size="sm" onClick={onBack}>
              Back
            </Button>
          )}
          {!interactive && (
            <Button kind="primary" size="sm" onClick={onNext}>
              {last ? 'Done' : 'Next'}
            </Button>
          )}
        </ButtonSet>
      </div>
    </div>
  );
}

/** One tour step: a spotlight and popover on the real page, or a centered panel when there is nothing to point at. */
export function GuideStepView(props: Props) {
  const { step, onNext, onClose } = props;
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const target = useGuideTarget(step.target);
  const modalOpen = useAppModalOpen();
  const advance = step.advance ?? { kind: 'next' };

  // Behind the collapsed navigation drawer a target cannot be pointed at.
  const hiddenInDrawer =
    target.element !== null &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia(NARROW_SHELL_QUERY).matches &&
    target.element.closest('.cds--side-nav') !== null;
  const element = hiddenInDrawer ? null : target.element;
  const rect = useElementRect(element);
  const waiting = step.target !== undefined && target.status === 'pending';
  const interactive = advance.kind !== 'next' && element !== null;

  const advanceOnClick = useLatestCallback(onNext);
  useEffect(() => {
    if (advance.kind !== 'click' || !element) return;
    const handler = (event: MouseEvent) => {
      // Later, so the page's own handler (navigation, opening a modal) runs first.
      if (event.target instanceof Node && element.contains(event.target)) window.setTimeout(advanceOnClick, 0);
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, [advance.kind, element, advanceOnClick]);

  useEffect(() => {
    element?.scrollIntoView?.({
      block: 'center',
      inline: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [element]);

  // A target taller than the screen leaves no room beside it for the popover, so a step that only needs reading
  // shows as the centered panel instead.
  const oversized = rect !== null && advance.kind === 'next' && rect.height > window.innerHeight * OVERSIZED_SHARE;
  const centered = (element === null && !waiting) || oversized;
  const popoverShown = element !== null && rect !== null && !oversized;

  const closeOnEscape = useLatestCallback((event: KeyboardEvent) => {
    // A modal of the page closes itself on Escape; the tour stays.
    if (event.key === 'Escape' && !modalOpen) onClose();
  });
  useEffect(() => {
    if (!popoverShown) return;
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [popoverShown, closeOnEscape]);

  // The popover centers on its target, which for a button at the edge of a narrow screen pushes it out of the
  // viewport. It is positioned a few frames after it appears, so the fit is repeated for a moment.
  useEffect(() => {
    if (!popoverShown) return;
    let frame = 0;
    let attempts = 0;
    const fit = () => {
      const popover = panelRef.current?.closest<HTMLElement>('.guide-popover__content');
      if (popover) {
        const shift = Number(popover.dataset.guideShift ?? 0);
        const box = popover.getBoundingClientRect();
        const left = box.left - shift;
        const right = box.right - shift;
        let next = 0;
        if (right > window.innerWidth - VIEWPORT_MARGIN) next = window.innerWidth - VIEWPORT_MARGIN - right;
        if (left + next < VIEWPORT_MARGIN) next = VIEWPORT_MARGIN - left;
        if (next !== shift) {
          popover.dataset.guideShift = String(next);
          popover.style.translate = `${next}px 0`;
        }
      }
      if (attempts++ < 30) frame = requestAnimationFrame(fit);
    };
    fit();
    return () => cancelAnimationFrame(frame);
  }, [popoverShown, rect]);

  // Each step moves focus into the panel, except while a modal of the page holds focus. The popover stays
  // `visibility: hidden` until it has been positioned, and a hidden element cannot take focus, hence the retries.
  useEffect(() => {
    if (!popoverShown || modalOpen) return;
    let frame = 0;
    let attempts = 0;
    const focusPanel = () => {
      panelRef.current?.focus({ preventScroll: true });
      if (document.activeElement !== panelRef.current && attempts++ < 30) frame = requestAnimationFrame(focusPanel);
    };
    focusPanel();
    return () => cancelAnimationFrame(frame);
  }, [popoverShown, modalOpen, step.id]);

  if (centered) {
    return (
      <Modal
        open
        passiveModal
        size="xs"
        className="guide-modal"
        modalHeading={step.title}
        onRequestClose={onClose}
        preventCloseOnClickOutside
      >
        <StepContent {...props} heading={false} titleId={titleId} interactive={false} />
      </Modal>
    );
  }
  if (!popoverShown) return null;

  const pad = SPOTLIGHT_PADDING;
  return (
    <>
      {!modalOpen && advance.kind === 'next' && <div className="guide-blocker" />}
      <div
        className={`guide-spotlight${modalOpen ? ' guide-spotlight--ring' : ''}`}
        style={{
          top: rect.top - pad,
          left: rect.left - pad,
          width: rect.width + 2 * pad,
          height: rect.height + 2 * pad,
        }}
      />
      <Popover
        open
        autoAlign
        caret
        align={step.placement ?? 'bottom'}
        className={`guide-popover${modalOpen ? ' guide-popover--above-modal' : ''}`}
      >
        <div
          className="guide-anchor"
          aria-hidden="true"
          style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }}
        />
        <PopoverContent className="guide-popover__content">
          <div ref={panelRef} role="dialog" aria-labelledby={titleId} tabIndex={-1} className="guide-panel">
            <StepContent {...props} heading titleId={titleId} interactive={interactive} />
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
