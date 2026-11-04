import { http, HttpResponse } from 'msw';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PermissionId } from '../../api/generated/models';
import { server } from '../../test/server';
import { currentUserFixture } from '../../test/fixtures';
import { renderRoute } from '../../test/render';
import { hasPermission } from '../auth/permissions';
import { GuideProvider, useGuides } from './GuideProvider';
import type { GuideDefinition } from './types';

const hoisted = vi.hoisted(() => ({
  user: null as unknown,
  demo: { active: false, listeners: new Set<() => void>() },
}));

vi.mock('../auth/auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../auth/auth')>()),
  useCurrentUser: () => hoisted.user,
}));

vi.mock('../demo/demoMode', async () => {
  const { useSyncExternalStore } = await import('react');
  const set = (value: boolean) => {
    hoisted.demo.active = value;
    hoisted.demo.listeners.forEach((listener) => listener());
  };
  return {
    isDemoMode: () => hoisted.demo.active,
    subscribeDemoMode: (listener: () => void) => {
      hoisted.demo.listeners.add(listener);
      return () => hoisted.demo.listeners.delete(listener);
    },
    useDemoMode: () =>
      useSyncExternalStore(
        (listener) => {
          hoisted.demo.listeners.add(listener);
          return () => hoisted.demo.listeners.delete(listener);
        },
        () => hoisted.demo.active,
      ),
    enterDemoMode: vi.fn(async () => set(true)),
    exitDemoMode: vi.fn(async () => set(false)),
  };
});

vi.mock('./content', () => {
  const base = {
    area: 'getting-started' as const,
    summary: 's',
    duration: '1 min',
    kind: 'tour' as const,
    demo: false,
    requires: () => true,
  };
  const guides: GuideDefinition[] = [
    {
      ...base,
      id: 'basic',
      title: 'Basic',
      steps: [
        { id: 'one', title: 'First step', body: 'Alpha body.', target: '[data-guide="alpha"]' },
        {
          id: 'hidden',
          title: 'Hidden step',
          body: 'Only for managers.',
          requires: (user) => hasPermission(user, 'people.read.all'),
        },
        { id: 'three', title: 'Third step', body: 'Centered, nothing to point at.' },
      ],
    },
    {
      ...base,
      id: 'interactive',
      title: 'Interactive',
      steps: [
        {
          id: 'click',
          title: 'Click it',
          body: 'Press the button.',
          target: '[data-guide="beta"]',
          advance: { kind: 'click' },
        },
        {
          id: 'go',
          title: 'Go there',
          body: 'Follow the link.',
          target: '[data-guide="link"]',
          advance: { kind: 'route', pattern: /^\/next$/ },
        },
        { id: 'end', title: 'Arrived', body: 'You made it.', route: '/other' },
      ],
    },
    {
      ...base,
      id: 'choice',
      title: 'Choice',
      steps: [
        {
          id: 'pick',
          title: 'Pick the second one',
          body: 'Choose Beta option.',
          target: '[data-guide="menu"]',
          allowOnly: { field: '[data-guide="menu"]', text: 'Beta option' },
          advance: {
            kind: 'when',
            check: () => document.querySelector('output[aria-label="picked"]')?.textContent === 'Beta option',
          },
        },
        { id: 'after', title: 'After the pick', body: 'Moved on by itself.', target: '[data-guide="alpha"]' },
      ],
    },
    {
      ...base,
      id: 'centered',
      title: 'Centered',
      steps: [
        { id: 'c1', title: 'Nothing to point at', body: 'First paragraph.\n\nSecond paragraph.' },
        { id: 'c2', title: 'Still nothing', body: 'Another one.' },
      ],
    },
    {
      ...base,
      id: 'leave',
      title: 'Leave',
      steps: [
        {
          id: 'open',
          title: 'Open the dialog',
          body: 'Press it.',
          route: '/home',
          target: '[data-guide="home-open"]',
          advance: { kind: 'click' },
        },
        {
          id: 'inside',
          title: 'Fill the dialog',
          body: 'Type something.',
          target: '[data-guide="in-dialog"]',
        },
      ],
    },
    {
      ...base,
      id: 'workflow',
      title: 'Workflow',
      kind: 'workflow' as const,
      demo: true,
      steps: [{ id: 'only', title: 'Demo step', body: 'Sample data.', target: '[data-guide="alpha"]' }],
    },
  ];
  return { guides };
});

/** A page with a button that opens a modal of its own; leaving the page closes the modal. */
function HomePage() {
  const [dialogOpen, setDialogOpen] = useState(false);
  return (
    <>
      <button data-guide="home-open" onClick={() => setDialogOpen(true)}>
        Open dialog
      </button>
      {dialogOpen && (
        <div className="cds--modal is-visible">
          <input data-guide="in-dialog" aria-label="field" />
        </div>
      )}
    </>
  );
}

function Harness({ guide }: { guide: string }) {
  const { startGuide, activeGuideId } = useGuides();
  const location = useLocation();
  const [picked, setPicked] = useState('nothing');
  return (
    <>
      {location.pathname === '/home' && <HomePage />}
      <Link to="/elsewhere">go elsewhere</Link>
      <ul data-guide="menu" role="listbox">
        {['Alpha option', 'Beta option', 'Gamma option'].map((name) => (
          <li key={name} role="option" aria-selected={picked === name} onClick={() => setPicked(name)}>
            {name}
          </li>
        ))}
      </ul>
      <output aria-label="picked">{picked}</output>
      <button onClick={() => startGuide(guide)}>launch</button>
      <button data-guide="alpha">Alpha</button>
      <button data-guide="beta">Beta</button>
      <Link data-guide="link" to="/next">
        next page
      </Link>
      <output aria-label="location">{location.pathname}</output>
      <output aria-label="active">{activeGuideId ?? 'none'}</output>
    </>
  );
}

function setup(guide: string, permissions: PermissionId[] = []) {
  hoisted.user = currentUserFixture(permissions);
  const view = renderRoute(
    <GuideProvider>
      <Harness guide={guide} />
    </GuideProvider>,
    '/start',
  );
  return { ...view, user: userEvent.setup() };
}

// The popover stays `visibility: hidden` in jsdom (floating-ui finds no layout), which hides it from role queries.
const currentStep = () => document.querySelector<HTMLElement>('[role="dialog"]');
const expectStep = (title: string) =>
  waitFor(() => {
    const dialog = currentStep();
    expect(dialog).not.toBeNull();
    expect(within(dialog!).getByText(title)).toBeInTheDocument();
  });
const expectNoStep = () => waitFor(() => expect(currentStep()).toBeNull());
const button = (name: string) => screen.getByText(name, { selector: 'button' });

describe('guide engine', () => {
  beforeEach(() => {
    hoisted.demo.active = false;
    // jsdom has no layout: give the guide targets a box.
    const box = (width: number, height: number) =>
      ({
        top: 40,
        left: 40,
        width,
        height,
        right: 40 + width,
        bottom: 40 + height,
        x: 40,
        y: 40,
        toJSON: () => ({}),
      }) as DOMRect;
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      return this.hasAttribute('data-guide') ? box(120, 32) : box(0, 0);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('skips steps the person lacks the permission for and moves with Next and Back', async () => {
    const { user } = setup('basic');
    await user.click(screen.getByRole('button', { name: 'launch' }));

    await expectStep('First step');
    expect(currentStep()).toHaveTextContent('Step 1 of 2');
    const labelId = currentStep()!.getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelId)).toHaveTextContent('First step');
    expect(screen.queryByText('Back', { selector: 'button' })).not.toBeInTheDocument();
    await waitFor(() => expect(currentStep()).toHaveFocus());
    expect(document.querySelector('.guide-live')).toHaveTextContent('Step 1 of 2: First step');

    await user.click(button('Next'));
    await expectStep('Third step');
    expect(screen.queryByText('Hidden step')).not.toBeInTheDocument();
    expect(screen.getByText('Step 2 of 2')).toBeInTheDocument();

    await user.click(button('Back'));
    await expectStep('First step');
  });

  it('includes a step when its permission is held', async () => {
    const { user } = setup('basic', [PermissionId.peoplereadall]);
    await user.click(screen.getByRole('button', { name: 'launch' }));
    await expectStep('First step');
    expect(currentStep()).toHaveTextContent('Step 1 of 3');
  });

  it('closes with the button or Escape, returns focus and leaves progress untouched', async () => {
    const written = vi.fn();
    server.use(
      http.put('*/api/v1/me/guides/:id', () => {
        written();
        return HttpResponse.json({});
      }),
    );
    const { user } = setup('basic');
    const launch = screen.getByRole('button', { name: 'launch' });
    await user.click(launch);
    await expectStep('First step');
    await user.keyboard('{Escape}');
    await expectNoStep();
    expect(launch).toHaveFocus();

    await user.click(launch);
    await expectStep('First step');
    // The icon button's name comes from a tooltip that jsdom treats as hidden.
    await user.click(currentStep()!.querySelector<HTMLElement>('button[aria-labelledby]')!);
    await expectNoStep();
    expect(screen.getByLabelText('active')).toHaveTextContent('none');
    expect(written).not.toHaveBeenCalled();
  });

  it('advances on a click of the real target, follows routes and records completion', async () => {
    let body: unknown = null;
    let guideId = '';
    server.use(
      http.put('*/api/v1/me/guides/:id', async ({ request, params }) => {
        body = await request.json();
        guideId = String(params.id);
        return HttpResponse.json({ guideId, status: 'completed', updatedAt: '2026-01-01T00:00:00Z' });
      }),
    );
    const { user } = setup('interactive');
    await user.click(screen.getByRole('button', { name: 'launch' }));

    await expectStep('Click it');
    expect(currentStep()).toHaveTextContent('Click the highlighted element');
    expect(screen.queryByText('Next', { selector: 'button' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Beta' }));

    await expectStep('Go there');
    await user.click(screen.getByRole('link', { name: 'next page' }));
    // The last step has a route of its own and shows centered, as it points at nothing.
    await expectStep('Arrived');
    expect(screen.getByLabelText('location')).toHaveTextContent('/other');

    await user.click(button('Done'));
    await waitFor(() => expect(body).toEqual({ status: 'completed' }));
    expect(guideId).toBe('interactive');
    await expectNoStep();
  });

  it('runs workflow guides in demo mode and leaves it when the guide ends', async () => {
    const demo = await import('../demo/demoMode');
    server.use(
      http.put('*/api/v1/me/guides/:id', () =>
        HttpResponse.json({ guideId: 'workflow', status: 'completed', updatedAt: '2026-01-01T00:00:00Z' }),
      ),
    );
    const { user } = setup('workflow');
    await user.click(screen.getByRole('button', { name: 'launch' }));

    await expectStep('Demo step');
    expect(demo.enterDemoMode).toHaveBeenCalledTimes(1);
    expect(demo.exitDemoMode).not.toHaveBeenCalled();

    await user.click(button('Done'));
    await waitFor(() => expect(demo.exitDemoMode).toHaveBeenCalled());
    expect(screen.getByLabelText('location')).toHaveTextContent('/start');
  });

  it('stops a workflow guide when demo mode is left from the banner', async () => {
    const demo = await import('../demo/demoMode');
    const { user } = setup('workflow');
    await user.click(screen.getByRole('button', { name: 'launch' }));
    await expectStep('Demo step');

    await act(async () => {
      await demo.exitDemoMode();
    });
    await expectNoStep();
    expect(screen.getByLabelText('active')).toHaveTextContent('none');
  });

  it('blocks the options a choice step does not allow and moves on by itself after the right pick', async () => {
    const { user } = setup('choice');
    await user.click(screen.getByRole('button', { name: 'launch' }));
    await expectStep('Pick the second one');
    // No Next button: the hint replaces it.
    expect(currentStep()).toHaveTextContent('Make your choice to move on');
    expect(screen.queryByText('Next', { selector: 'button' })).not.toBeInTheDocument();

    const alpha = screen.getByRole('option', { name: 'Alpha option' });
    const beta = screen.getByRole('option', { name: 'Beta option' });
    await waitFor(() => expect(alpha).toHaveAttribute('aria-disabled', 'true'));
    expect(alpha).toHaveClass('guide-option-disabled');
    expect(beta).not.toHaveAttribute('aria-disabled');

    await user.click(alpha);
    expect(screen.getByLabelText('picked')).toHaveTextContent('nothing');
    expect(currentStep()).toHaveTextContent('Pick the second one');

    await user.click(beta);
    expect(screen.getByLabelText('picked')).toHaveTextContent('Beta option');
    await expectStep('After the pick');
    // Leaving the step lifts the restriction.
    await waitFor(() => expect(alpha).not.toHaveAttribute('aria-disabled'));
  });

  it('advances on a programmatic click of the target', async () => {
    const { user } = setup('interactive');
    await user.click(screen.getByRole('button', { name: 'launch' }));
    await expectStep('Click it');
    act(() => screen.getByRole('button', { name: 'Beta' }).click());
    await expectStep('Go there');
  });

  it('shows a centered step as a standard modal: heading, spaced text, progress and a two-button footer', async () => {
    const { user } = setup('centered');
    await user.click(screen.getByRole('button', { name: 'launch' }));

    const heading = await screen.findByRole('heading', { name: 'Nothing to point at' });
    const modal = heading.closest<HTMLElement>('.cds--modal-container')!;
    expect(modal.closest('.guide-modal')).not.toBeNull();
    expect(within(modal).getByText('First paragraph.')).toBeInTheDocument();
    expect(within(modal).getByText('Second paragraph.')).toBeInTheDocument();
    expect(within(modal).getByText('Step 1 of 2')).toBeInTheDocument();
    // The first step only has its primary button.
    const footer = modal.querySelector('.cds--modal-footer')!;
    expect(
      within(footer as HTMLElement)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['Next']);

    await user.click(within(footer as HTMLElement).getByRole('button', { name: 'Next' }));
    const second = (await screen.findByRole('heading', { name: 'Still nothing' })).closest<HTMLElement>(
      '.cds--modal-container',
    )!;
    expect(
      within(second.querySelector<HTMLElement>('.cds--modal-footer')!)
        .getAllByRole('button')
        .map((item) => item.textContent),
    ).toEqual(['Back', 'Done']);
  });

  it('says so when the person leaves the tour and brings them back to the step', async () => {
    const { user } = setup('leave');
    await user.click(screen.getByRole('button', { name: 'launch' }));
    await expectStep('Open the dialog');
    expect(screen.getByLabelText('location')).toHaveTextContent('/home');

    // Navigating elsewhere takes the step's target away; the tour does not fall back to the centered text.
    await user.click(screen.getByRole('link', { name: 'go elsewhere' }));
    expect(await screen.findByText('You left the tour')).toBeInTheDocument();
    expect(screen.getByLabelText('location')).toHaveTextContent('/elsewhere');
    expect(screen.queryByText('Press it.')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to the tour' }));
    await expectStep('Open the dialog');
    expect(screen.getByLabelText('location')).toHaveTextContent('/home');
    expect(screen.queryByText('You left the tour')).not.toBeInTheDocument();
  });

  it('returns to the step that opens a page modal when the person leaves while it is open', async () => {
    const { user } = setup('leave');
    await user.click(screen.getByRole('button', { name: 'launch' }));
    await expectStep('Open the dialog');
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    await expectStep('Fill the dialog');

    await user.click(screen.getByRole('link', { name: 'go elsewhere' }));
    expect(await screen.findByText('You left the tour')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Back to the tour' }));
    // The modal is gone after leaving, so the tour is back at the click that opens it, on its page.
    await expectStep('Open the dialog');
    expect(screen.getByLabelText('location')).toHaveTextContent('/home');
    expect(screen.queryByRole('textbox', { name: 'field' })).not.toBeInTheDocument();
  });

  it('ends the tour from the left-the-tour dialog', async () => {
    const { user } = setup('leave');
    await user.click(screen.getByRole('button', { name: 'launch' }));
    await expectStep('Open the dialog');
    await user.click(screen.getByRole('link', { name: 'go elsewhere' }));
    await user.click(await screen.findByRole('button', { name: 'End tour' }));
    await waitFor(() => expect(screen.getByLabelText('active')).toHaveTextContent('none'));
    expect(screen.queryByText('You left the tour')).not.toBeInTheDocument();
  });

  it("keeps today's behaviour on the expected page: a missing target waits instead of claiming the tour was left", async () => {
    const { user } = setup('leave');
    await user.click(screen.getByRole('button', { name: 'launch' }));
    await expectStep('Open the dialog');
    await user.click(screen.getByRole('button', { name: 'Open dialog' }));
    await expectStep('Fill the dialog');
    // Same page, target present: nothing about leaving.
    expect(screen.queryByText('You left the tour')).not.toBeInTheDocument();
  });
});
