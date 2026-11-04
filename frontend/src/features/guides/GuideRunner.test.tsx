import { http, HttpResponse } from 'msw';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
      id: 'workflow',
      title: 'Workflow',
      kind: 'workflow' as const,
      demo: true,
      steps: [{ id: 'only', title: 'Demo step', body: 'Sample data.', target: '[data-guide="alpha"]' }],
    },
  ];
  return { guides };
});

function Harness({ guide }: { guide: string }) {
  const { startGuide, activeGuideId } = useGuides();
  const location = useLocation();
  return (
    <>
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
    await user.click(button('Close tour'));
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
    expect(currentStep()).toHaveTextContent('Click the highlighted element.');
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
});
