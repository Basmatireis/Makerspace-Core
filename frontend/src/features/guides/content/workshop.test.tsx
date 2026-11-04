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
const passes = (guideId: string, stepId: string) => {
  const advance = guide(guideId).steps.find((step) => step.id === stepId)?.advance;
  if (advance?.kind !== 'when') throw new Error(`${guideId}/${stepId} does not advance by a check`);
  return advance.check();
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
    expect(steps.map((step) => step.id)).toEqual([
      'nav-inventory',
      'inventory-articles',
      'spools-tab',
      'inventory-spools',
    ]);
    const noMachines = demoTestUser(['machine_jobs.read', 'inventory.read']);
    const ids = guide('workshop-tour')
      .steps.filter((step) => step.requires?.(noMachines) ?? true)
      .map((step) => step.id);
    expect(ids).not.toContain('nav-machines');
    expect(ids).not.toContain('machines');
  });

  it('tour: only the first step jumps to a route', () => {
    const steps = guide('workshop-tour').steps;
    expect(steps[0].route).toBeDefined();
    expect(steps.slice(1).filter((step) => step.route)).toEqual([]);
  });

  it('tour: follows the pages through the menu and the tabs', async () => {
    const user = userEvent.setup();
    const step = (id: string) => stepTarget('workshop-tour', id);
    const click = async (id: string) => {
      await exists(step(id));
      await user.click(document.querySelector<HTMLElement>(step(id))!);
    };
    await start('/workshop/jobs');
    for (const id of ['jobs-tabs', 'unassigned', 'toolbar']) await exists(step(id));
    await click('job-link');
    await exists(step('job-detail'));
    await click('nav-machines');
    for (const id of ['machines', 'machine-tabs']) await exists(step(id));
    await click('nav-inventory');
    await exists(step('inventory-articles'));
    await click('spools-tab');
    await exists(step('inventory-spools'));
  });

  it('log a job: machine, recipient and material are picked step by step', async () => {
    const user = userEvent.setup();
    const step = (id: string) => stepTarget('workshop-log-job', id);
    await start('/workshop/jobs');
    await exists(step('new-job'));
    await user.click(document.querySelector<HTMLElement>(step('new-job'))!);
    for (const id of ['machine', 'recipient', 'operator', 'create']) await exists(step(id));
    expect(passes('workshop-log-job', 'machine')).toBe(false);
    await user.click(document.querySelector<HTMLElement>(step('machine'))!);
    await user.click(await screen.findByRole('option', { name: /Laser cutter/ }));
    expect(passes('workshop-log-job', 'machine')).toBe(true);
    await exists(step('first-run'));
    expect(passes('workshop-log-job', 'recipient')).toBe(false);
    await user.click(document.querySelector<HTMLElement>(step('recipient'))!);
    await user.click(await screen.findByRole('option', { name: /Demo Robotics Club/ }));
    expect(passes('workshop-log-job', 'recipient')).toBe(true);
    expect(passes('workshop-log-job', 'pick-material')).toBe(false);
    await user.click(document.querySelector<HTMLElement>(step('material'))!);
    await exists(step('pick-material'));
    expect(document.querySelectorAll(step('pick-material'))).toHaveLength(1);
    await user.click(document.querySelector<HTMLElement>(step('pick-material'))!);
    await waitFor(() => expect(passes('workshop-log-job', 'pick-material')).toBe(true));
    expect(passes('workshop-log-job', 'amount')).toBe(false);
    await user.type(document.querySelector<HTMLInputElement>(step('amount'))!, '0.5');
    expect(passes('workshop-log-job', 'amount')).toBe(true);
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
    expect(passes('workshop-claim-run', 'mode')).toBe(true);
    await exists(stepTarget('workshop-claim-run', 'recipient'));
    await exists(stepTarget('workshop-claim-run', 'title'));
    await user.click(document.querySelector<HTMLElement>('#claim-customer')!);
    await user.click(await screen.findByRole('option', { name: /Demo Robotics Club/ }));
    expect(passes('workshop-claim-run', 'recipient')).toBe(true);
  });

  it('receive stock: button, modal fields and the list', async () => {
    const user = userEvent.setup();
    const step = (id: string) => stepTarget('workshop-receive-stock', id);
    await start('/workshop/inventory');
    await exists(step('open'));
    await exists(step('result'));
    await user.click(document.querySelector<HTMLElement>(step('open'))!);
    await exists(step('article'));
    await exists(step('packages'));
    await exists(step('price'));
    await exists(step('submit'));
    expect(passes('workshop-receive-stock', 'article')).toBe(false);
    await user.click(document.querySelector<HTMLElement>(step('article'))!);
    await user.click(await screen.findByRole('option', { name: /PLA Basic Black/ }));
    expect(passes('workshop-receive-stock', 'article')).toBe(true);
    const count = document.querySelector<HTMLInputElement>(step('packages'))!;
    await user.clear(count);
    await user.type(count, '2');
    expect(passes('workshop-receive-stock', 'packages')).toBe(true);
    const price = document.querySelector<HTMLInputElement>(step('price'))!;
    await user.clear(price);
    await user.type(price, '40');
    expect(passes('workshop-receive-stock', 'price')).toBe(true);
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
