import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { getCurrentUser } from '../../api/generated/authentication/authentication';
import { queryClient } from '../../api/query-client';
import { server } from '../../test/server';
import { DemoBanner } from './DemoBanner';
import { enterDemoMode, exitDemoMode, isDemoMode, subscribeDemoMode } from './demoMode';
import { demoTestUser } from './demoTestUser';

afterEach(async () => {
  await exitDemoMode();
  queryClient.clear();
});

describe('demo mode', () => {
  it('switches the API to the fake backend, clears the cache and restores the network on exit', async () => {
    const user = demoTestUser();
    server.use(
      http.get('*/api/v1/auth/me', () =>
        HttpResponse.json({ code: 'unauthenticated', message: 'No.' }, { status: 401 }),
      ),
    );
    queryClient.setQueryData(['private'], 'real data');
    const changes: boolean[] = [];
    const unsubscribe = subscribeDemoMode(() => changes.push(isDemoMode()));

    await enterDemoMode(user);

    expect(isDemoMode()).toBe(true);
    expect(queryClient.getQueryData(['private'])).toBeUndefined();
    expect((await getCurrentUser()).person.id).toBe(user.person.id);

    await exitDemoMode();

    expect(isDemoMode()).toBe(false);
    await expect(getCurrentUser()).rejects.toMatchObject({ status: 401 });
    unsubscribe();
    expect(changes).toEqual([true, false]);
  });

  it('keeps writes away from the network while active', async () => {
    let networkWrites = 0;
    server.use(
      http.post('*/api/v1/orders', () => {
        networkWrites += 1;
        return HttpResponse.json({});
      }),
    );
    await enterDemoMode(demoTestUser());
    const { createOrder } = await import('../../api/generated/orders/orders');
    const order = await createOrder({ fulfillmentMode: 'immediate' });
    expect(order.status).toBe('draft');
    expect(networkWrites).toBe(0);
  });

  it('ignores an enter that is overtaken by an exit', async () => {
    const pending = enterDemoMode(demoTestUser());
    await exitDemoMode();
    await pending;
    expect(isDemoMode()).toBe(false);
  });
});

describe('DemoBanner', () => {
  it('renders nothing outside demo mode and offers to leave inside it', async () => {
    render(<DemoBanner />);
    expect(screen.queryByText('Demo mode')).not.toBeInTheDocument();

    await act(() => enterDemoMode(demoTestUser()));
    expect(await screen.findByText('Demo mode')).toBeInTheDocument();
    expect(screen.getByText("You're working with sample data. Nothing you do here is saved.")).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Leave demo' }));
    expect(isDemoMode()).toBe(false);
    expect(screen.queryByText('Demo mode')).not.toBeInTheDocument();
  });
});
