import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../../app/App';
import { queryClient } from '../../../api/query-client';
import { renderRoute } from '../../../test/render';
import { enterDemoMode, exitDemoMode } from '../../demo/demoMode';
import { demoTestUser } from '../../demo/demoTestUser';
import type { GuideDefinition } from '../types';
import { workshopArticles } from '../../help/articles/workshop';
import { workshopGuides } from './workshop';

vi.mock('@carbon/charts-react', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  SimpleBarChart: () => <div data-testid="bar-chart" />,
}));

afterEach(async () => {
  await exitDemoMode();
  queryClient.clear();
});

const guide = (id: string): GuideDefinition => {
  const found = workshopGuides.find((item) => item.id === id);
  if (!found) throw new Error(`Unknown guide ${id}`);
  return found;
};
const exists = (selector: string) =>
  waitFor(() => {
    if (!document.querySelector(selector)) throw new Error(`Missing ${selector}`);
  });
const stepTarget = (guideId: string, stepId: string) => {
  const target = guide(guideId).steps.find((step) => step.id === stepId)?.target;
  if (!target) throw new Error(`No target for ${guideId}/${stepId}`);
  return target;
};
const start = async (route: string) => {
  await enterDemoMode(demoTestUser());
  renderRoute(<App />, route);
};

describe('workshop guides', () => {
  it('have unique ids and are hidden from people without workshop permissions', () => {
    const ids = workshopGuides.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['workshop-tour', 'workshop-log-job', 'workshop-claim-run', 'workshop-receive-stock']);
    const nobody = demoTestUser([]);
    for (const item of workshopGuides) {
      expect(item.demo).toBe(true);
      expect(item.requires(nobody)).toBe(false);
      expect(item.requires(demoTestUser())).toBe(true);
      const stepIds = item.steps.map((step) => step.id);
      expect(new Set(stepIds).size).toBe(stepIds.length);
    }
    expect(guide('workshop-tour').requires(demoTestUser(['inventory.read']))).toBe(true);
    expect(guide('workshop-log-job').requires(demoTestUser(['machine_jobs.read', 'machine_jobs.create']))).toBe(false);
    expect(guide('workshop-receive-stock').requires(demoTestUser(['inventory.read']))).toBe(false);
  });

  it('keeps only the tour steps a read-only person can use', () => {
    const user = demoTestUser(['inventory.read']);
    const steps = guide('workshop-tour').steps.filter((step) => step.requires?.(user) ?? true);
    expect(steps.map((step) => step.id)).toEqual(['inventory-articles', 'inventory-spools']);
  });

  it('tour: every target exists on its page', async () => {
    const steps = guide('workshop-tour').steps;
    const routes = [...new Set(steps.map((step) => step.route))];
    // The jobs page is the first route; later routes are visited by the guide itself.
    await start(routes[0]!);
    for (const route of routes) {
      if (route !== routes[0]) {
        await exitDemoMode();
        queryClient.clear();
        document.body.innerHTML = '';
        await start(route!);
      }
      let current = '';
      for (const step of steps) {
        if (step.route) current = step.route;
        if (current === route && step.target) await exists(step.target);
      }
    }
  });

  it('log a job: the form fields and the result are there', async () => {
    const user = userEvent.setup();
    await start('/workshop/jobs');
    await exists(stepTarget('workshop-log-job', 'new-job'));
    await user.click(document.querySelector<HTMLElement>(stepTarget('workshop-log-job', 'new-job'))!);
    await exists(stepTarget('workshop-log-job', 'machine'));
    await exists(stepTarget('workshop-log-job', 'recipient'));
    await exists(stepTarget('workshop-log-job', 'operator'));
    await exists(stepTarget('workshop-log-job', 'create'));
    await user.click(document.querySelector<HTMLElement>('#job-form-machine')!);
    await user.click(await screen.findByRole('option', { name: /Laser/ }));
    await exists(stepTarget('workshop-log-job', 'first-run'));
  });

  it('log a job: the new job page has the runs target', async () => {
    await start('/workshop/jobs/01990000-0000-7000-8000-000000000401');
    await exists(stepTarget('workshop-log-job', 'result'));
  });

  it('claim a run: strip, claim button and modal fields', async () => {
    const user = userEvent.setup();
    await start('/workshop/jobs');
    await exists(stepTarget('workshop-claim-run', 'strip'));
    await exists(stepTarget('workshop-claim-run', 'claim'));
    await user.click(document.querySelector<HTMLElement>(stepTarget('workshop-claim-run', 'claim'))!);
    await exists(stepTarget('workshop-claim-run', 'mode'));
    await exists(stepTarget('workshop-claim-run', 'create'));
    await user.click(await screen.findByLabelText('New job'));
    await exists(stepTarget('workshop-claim-run', 'recipient'));
    await exists(stepTarget('workshop-claim-run', 'title'));
  });

  it('receive stock: button, modal fields and the list', async () => {
    const user = userEvent.setup();
    await start('/workshop/inventory');
    await exists(stepTarget('workshop-receive-stock', 'open'));
    await exists(stepTarget('workshop-receive-stock', 'result'));
    await user.click(document.querySelector<HTMLElement>(stepTarget('workshop-receive-stock', 'open'))!);
    await exists(stepTarget('workshop-receive-stock', 'article'));
    await exists(stepTarget('workshop-receive-stock', 'packages'));
    await exists(stepTarget('workshop-receive-stock', 'price'));
    await exists(stepTarget('workshop-receive-stock', 'submit'));
  });

  it('articles load, are gated by permission and point at existing guides', async () => {
    const nobody = demoTestUser([]);
    const guideIds = workshopGuides.map((item) => item.id);
    for (const article of workshopArticles) {
      expect(article.requires(nobody)).toBe(false);
      expect(article.requires(demoTestUser())).toBe(true);
      for (const related of article.relatedGuides ?? []) expect(guideIds).toContain(related);
      expect((await article.load()).length).toBeGreaterThan(300);
    }
  });
});
