import { useEffect, useId, useLayoutEffect, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { useLocation } from 'react-router-dom';
import { Button, ButtonSet, IconButton, Modal, Popover, PopoverContent } from '@carbon/react';
import { Close } from '@carbon/icons-react';
import { useLatestCallback } from '../../app/useLatestCallback';
import './guides.scss';
import type { GuideStep } from './types';
import { useGuideChoice } from './useGuideChoice';
import { useAppModal, useElementRect, useGuideTarget, type TargetRect } from './useGuideTarget';

const SPOTLIGHT_PADDING = 4;
const SPOTLIGHT_RADIUS = 4;
const OVERSIZED_SHARE = 0.7;
const VIEWPORT_MARGIN = 8;
const MODAL_GAP = 16;

/** Where a step's target was last seen: the page (path and query) and whether it sits inside a page modal. */
export interface StepAnchor {
  path: string;
  insideModal: boolean;
}

/** How long a step's target may be missing on a different page before the tour asks whether it was left. */
const LEFT_TOUR_DELAY_MS = 200;

interface Props {
  step: GuideStep;
  index: number;
  total: number;
  /** The page the step belongs to, when it is known beforehand (its route, or where it was seen before). */
  home?: string;
  onAnchor?: (stepId: string, anchor: StepAnchor) => void;
  /** Takes the person back to the page (and step) they left. */
  onReturn?: () => void;
  onBack: () => void;
  onNext: () => void;
  onClose: () => void;
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function paragraphs(text: string) {
  return text.split(/\n\s*\n/).map((paragraph) => <p key={paragraph}>{paragraph}</p>);
}

/** The popover's content: heading with a close button, text, progress and a full-width button footer. */
function StepPanel({
  step,
  index,
  total,
  titleId,
  interactive,
  panelRef,
  onBack,
  onNext,
  onClose,
}: Props & {
  titleId: string;
  /** The step waits for the person to use the page, so Next is replaced by a hint. */
  interactive: boolean;
  panelRef: Ref<HTMLDivElement>;
}) {
  const last = index === total - 1;
  const kind = step.advance?.kind;
  const hint =
    kind === 'route'
      ? 'Continue in the app to move on'
      : kind === 'when'
        ? 'Make your choice to move on'
        : 'Click the highlighted element';
  return (
    <div ref={panelRef} role="dialog" aria-labelledby={titleId} tabIndex={-1} className="guide-panel">
      <div className="guide-panel__header">
        <h2 id={titleId} className="guide-panel__title">
          {step.title}
        </h2>
        <IconButton kind="ghost" size="sm" label="Close tour" align="bottom-end" onClick={onClose}>
          <Close />
        </IconButton>
      </div>
      <div className="guide-panel__body">
        {paragraphs(step.body)}
        <p className="guide-panel__progress">
          Step {index + 1} of {total}
        </p>
      </div>
      <ButtonSet className="guide-panel__footer">
        {index > 0 && (
          <Button kind="secondary" onClick={onBack}>
            Back
          </Button>
        )}
        {interactive ? (
          <p className="guide-panel__hint">{hint}</p>
        ) : (
          <Button kind="primary" onClick={onNext}>
            {last ? 'Done' : 'Next'}
          </Button>
        )}
      </ButtonSet>
    </div>
  );
}

/** A rounded hole in a full-screen rectangle (even-odd), in viewport pixels. */
function spotlightPath(rect: TargetRect, menu: TargetRect | null): string {
  const big = 100000;
  return `M${-big} ${-big}H${big}V${big}H${-big}Z` + outline(rect, SPOTLIGHT_PADDING) + (menu ? outline(menu, 0) : '');
}

function outline(rect: TargetRect, pad: number): string {
  const r = SPOTLIGHT_RADIUS;
  const x = rect.left - pad;
  const y = rect.top - pad;
  const w = rect.width + 2 * pad;
  const h = rect.height + 2 * pad;
  return (
    `M${x + r} ${y}H${x + w - r}A${r} ${r} 0 0 1 ${x + w} ${y + r}V${y + h - r}A${r} ${r} 0 0 1 ${x + w - r} ${y + h}` +
    `H${x + r}A${r} ${r} 0 0 1 ${x} ${y + h - r}V${y + r}A${r} ${r} 0 0 1 ${x + r} ${y}Z`
  );
}

function spotlightStyle(rect: TargetRect) {
  const pad = SPOTLIGHT_PADDING;
  return {
    top: rect.top - pad,
    left: rect.left - pad,
    width: rect.width + 2 * pad,
    height: rect.height + 2 * pad,
  };
}

/**
 * Where the docked panel goes while a modal of the page is open: beside the modal when there is room, otherwise in
 * a bar at the bottom of the screen (the modal then makes room for it). Never over the modal's box.
 */
function placeBesideModal(
  modal: TargetRect,
  size: { width: number; height: number },
  target: TargetRect,
): { top: number; left: number; docked: boolean } {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const top = Math.min(
    Math.max(target.top + target.height / 2 - size.height / 2, VIEWPORT_MARGIN),
    Math.max(VIEWPORT_MARGIN, viewportHeight - size.height - VIEWPORT_MARGIN),
  );
  const rightLeft = modal.left + modal.width + MODAL_GAP;
  const leftLeft = modal.left - MODAL_GAP - size.width;
  const fitsRight = rightLeft + size.width + VIEWPORT_MARGIN <= viewportWidth;
  const fitsLeft = leftLeft >= VIEWPORT_MARGIN;
  const preferLeft = target.left + target.width / 2 < modal.left + modal.width / 2;
  if (fitsLeft && (preferLeft || !fitsRight)) return { top, left: leftLeft, docked: false };
  if (fitsRight) return { top, left: rightLeft, docked: false };
  return {
    top: viewportHeight - size.height - VIEWPORT_MARGIN,
    left: Math.max(VIEWPORT_MARGIN, (viewportWidth - size.width) / 2),
    docked: true,
  };
}

/** The tour's panel while a page modal is open: fixed next to the modal instead of floating at the target. */
function DockedPanel({
  modalRect,
  targetRect,
  ...panel
}: Props & {
  titleId: string;
  interactive: boolean;
  modalRect: TargetRect | null;
  targetRect: TargetRect;
}) {
  const [shell, setShell] = useState<HTMLDivElement | null>(null);
  const size = useElementRect(shell, 'element');
  const place =
    modalRect && size ? placeBesideModal(modalRect, { width: size.width, height: size.height }, targetRect) : null;
  const docked = place?.docked === true;
  // The modal keeps its normal place and size unless the bar would overlap it. Once it had to make room it keeps
  // doing so (the shrunken modal would otherwise look like there was room again and flip back).
  const [needsRoom, setNeedsRoom] = useState(false);
  const overlaps = place !== null && modalRect !== null && modalRect.top + modalRect.height + MODAL_GAP > place.top;
  useEffect(() => {
    if (docked && overlaps) setNeedsRoom(true);
  }, [docked, overlaps]);
  const makeRoom = docked && needsRoom;
  const dockHeight = makeRoom && size ? size.height + VIEWPORT_MARGIN + MODAL_GAP : 0;

  // The modal leaves room below it for a bar at the bottom of the screen.
  useLayoutEffect(() => {
    if (!makeRoom) return;
    const root = document.documentElement;
    root.style.setProperty('--guide-dock-height', `${dockHeight}px`);
    root.dataset.guideDock = 'bottom';
    return () => {
      root.style.removeProperty('--guide-dock-height');
      delete root.dataset.guideDock;
    };
  }, [makeRoom, dockHeight]);

  return (
    <div
      ref={setShell}
      className="guide-dock"
      style={place ? { top: place.top, left: place.left } : { visibility: 'hidden', top: 0, left: 0 }}
    >
      <StepPanel {...panel} panelRef={null} />
    </div>
  );
}

/** One tour step: a spotlight and popover on the real page, or a centered modal when there is nothing to point at. */
export function GuideStepView(props: Props) {
  const { step, index, total, home, onAnchor, onReturn, onNext, onBack, onClose } = props;
  const { pathname, search } = useLocation();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const target = useGuideTarget(step.target);
  const modal = useAppModal();
  const modalOpen = modal !== null;
  const modalRect = useElementRect(modal, 'element');
  const advance = step.advance ?? { kind: 'next' };

  // The shell releases its stacking contexts only while Carbon's body class is set (see styles/index.scss); a page
  // modal opened during a tour step must not end up under the header and side navigation without it.
  useEffect(() => {
    if (modalOpen && !document.body.classList.contains('cds--body--with-modal-open')) {
      document.body.classList.add('cds--body--with-modal-open');
    }
  }, [modalOpen, modal]);

  const element = target.element;

  // The page this step belongs to: where its target was last found, else its known home, else where it started
  // (null while a route step is still on its way there). A missing target on a different page means the person
  // left; on the right page it only means the page is still loading.
  const [anchorPath, setAnchorPath] = useState<string | null>(() =>
    home === undefined ? pathname : pathname === home.split('?')[0] ? pathname : null,
  );
  useEffect(() => {
    if (anchorPath === null && home !== undefined && pathname === home.split('?')[0]) setAnchorPath(pathname);
  }, [anchorPath, home, pathname]);
  useEffect(() => {
    // The previous page's element lingers for a frame after the route changed.
    if (!element?.isConnected) return;
    setAnchorPath(pathname);
    onAnchor?.(step.id, { path: `${pathname}${search}`, insideModal: element.closest('.cds--modal') !== null });
  }, [element, pathname, search, step.id, onAnchor]);
  const away = step.target !== undefined && element === null && anchorPath !== null && anchorPath !== pathname;
  const [left, setLeft] = useState(false);
  useEffect(() => {
    if (!away) {
      setLeft(false);
      return;
    }
    // The page may still be switching over to the step's own page.
    const timer = window.setTimeout(() => setLeft(true), LEFT_TOUR_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [away]);

  // Restricted choices and the menu they open (which stays usable through the dim layer).
  const menu = useGuideChoice(step.allowOnly);
  const menuRect = useElementRect(menu, 'element');

  // A step that moves on by itself: re-checked when the page or a form control changes. A check that already
  // passes when the step appears (the person came back) falls back to the Next button.
  const when = advance.kind === 'when' ? advance.check : null;
  const [baseline, setBaseline] = useState<boolean | null>(null);
  useEffect(() => {
    // Measured once the target is on screen (a modal's fields only exist after it opened).
    if (when && element && baseline === null) setBaseline(when());
  }, [when, element, baseline]);
  const advanceByCheck = useLatestCallback(onNext);
  useEffect(() => {
    if (!when || baseline !== false) return;
    let frame = 0;
    const run = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (when()) advanceByCheck();
      });
    };
    const observer = new MutationObserver(run);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    const events = ['input', 'change', 'click', 'keyup'] as const;
    events.forEach((name) => document.addEventListener(name, run, true));
    return () => {
      observer.disconnect();
      events.forEach((name) => document.removeEventListener(name, run, true));
      cancelAnimationFrame(frame);
    };
  }, [when, baseline, advanceByCheck]);

  const rect = useElementRect(element, step.highlight ?? 'content');
  const waiting = step.target !== undefined && target.status === 'pending';
  const interactive = advance.kind !== 'next' && element !== null && !(when && baseline === true);

  const advanceOnClick = useLatestCallback(onNext);
  const selector = step.target;
  useEffect(() => {
    if (advance.kind !== 'click' || !element) return;
    const handler = (event: MouseEvent) => {
      const clicked = event.target;
      if (!(clicked instanceof Element)) return;
      // The target may have been re-rendered since it was found, so the selector counts too.
      const inside = element.contains(clicked) || (selector !== undefined && clicked.closest(selector) !== null);
      // Later, so the page's own handler (navigation, opening a modal) runs first.
      if (inside) window.setTimeout(advanceOnClick, 0);
    };
    document.addEventListener('click', handler, true);
    return () => document.removeEventListener('click', handler, true);
  }, [advance.kind, element, selector, advanceOnClick]);

  useEffect(() => {
    element?.scrollIntoView?.({
      block: 'center',
      inline: 'nearest',
      behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    });
  }, [element]);

  // A target taller than the screen leaves no room beside it for the popover, so a step that only needs reading
  // shows as the centered modal instead.
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
    if (!popoverShown || modalOpen) return;
    let frame = 0;
    let attempts = 0;
    const fit = () => {
      const popover = panelRef.current?.closest<HTMLElement>('.guide-popover__content');
      if (popover) {
        const shift = Number(popover.dataset.guideShift ?? 0);
        const box = popover.getBoundingClientRect();
        const left = box.left - shift;
        const right = box.right - shift;
        const shiftY = Number(popover.dataset.guideShiftY ?? 0);
        const top = box.top - shiftY;
        const bottom = box.bottom - shiftY;
        let next = 0;
        if (right > window.innerWidth - VIEWPORT_MARGIN) next = window.innerWidth - VIEWPORT_MARGIN - right;
        if (left + next < VIEWPORT_MARGIN) next = VIEWPORT_MARGIN - left;
        let nextY = 0;
        if (bottom > window.innerHeight - VIEWPORT_MARGIN) nextY = window.innerHeight - VIEWPORT_MARGIN - bottom;
        if (top + nextY < VIEWPORT_MARGIN) nextY = VIEWPORT_MARGIN - top;
        if (next !== shift || nextY !== shiftY) {
          popover.dataset.guideShift = String(next);
          popover.dataset.guideShiftY = String(nextY);
          popover.style.translate = `${next}px ${nextY}px`;
        }
      }
      if (attempts++ < 30) frame = requestAnimationFrame(fit);
    };
    fit();
    return () => cancelAnimationFrame(frame);
  }, [popoverShown, modalOpen, rect]);

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

  if (left && onReturn) {
    return (
      <Modal
        open
        size="sm"
        className="guide-modal"
        modalHeading="You left the tour"
        primaryButtonText="Back to the tour"
        secondaryButtonText="End tour"
        onRequestSubmit={onReturn}
        onSecondarySubmit={onClose}
        onRequestClose={onClose}
        closeButtonLabel="Close tour"
        preventCloseOnClickOutside
      >
        <p>This step belongs on another page. Go back to carry on where you were, or end the tour.</p>
      </Modal>
    );
  }
  if (centered) {
    return (
      <Modal
        open
        size="sm"
        className="guide-modal"
        modalHeading={step.title}
        primaryButtonText={index === total - 1 ? 'Done' : 'Next'}
        secondaryButtonText={index > 0 ? 'Back' : undefined}
        onRequestSubmit={onNext}
        onSecondarySubmit={onBack}
        onRequestClose={onClose}
        closeButtonLabel="Close tour"
        preventCloseOnClickOutside
      >
        {paragraphs(step.body)}
        <p className="guide-panel__progress">
          Step {index + 1} of {total}
        </p>
      </Modal>
    );
  }
  if (!popoverShown) return null;

  const hole = spotlightStyle(rect);
  // Hole and ring in one fixed layer above the header and navigation. Outside the hole the page cannot be used;
  // inside, only a step that waits for a click lets it through. A page modal sits above the dim, so it gets
  // just the ring.
  return (
    <>
      {createPortal(
        <>
          {!modalOpen && (
            <div
              className="guide-overlay"
              data-testid="guide-overlay"
              style={{ clipPath: `path(evenodd, "${spotlightPath(rect, menuRect)}")` }}
            />
          )}
          {!modalOpen && advance.kind === 'next' && <div className="guide-hole-blocker" style={hole} />}
          <div className={`guide-spotlight${modalOpen ? ' guide-spotlight--ring' : ''}`} style={hole} />
        </>,
        document.body,
      )}
      {modalOpen ? (
        <DockedPanel {...props} titleId={titleId} interactive={interactive} modalRect={modalRect} targetRect={rect} />
      ) : (
        <Popover open autoAlign caret align={step.placement ?? 'bottom'} className="guide-popover">
          <div className="guide-anchor" aria-hidden="true" style={hole} />
          <PopoverContent className="guide-popover__content">
            <StepPanel {...props} titleId={titleId} interactive={interactive} panelRef={panelRef} />
          </PopoverContent>
        </Popover>
      )}
    </>
  );
}
