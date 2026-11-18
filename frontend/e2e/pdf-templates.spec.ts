import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import {
  expectNoUnexpectedRequests,
  installPdfTemplatesApi,
  newWorld,
  sent,
  versionOf,
  builtinDocument,
  type World,
} from './pdf-templates-api';

async function open(page: Page, world: World) {
  await installPdfTemplatesApi(page, world);
  await page.goto('/settings/pdf-templates');
  await expect(page.getByRole('treeitem', { name: /Page setup/ })).toBeVisible();
  // The first render of the preview has arrived and is drawn.
  await expect(page.locator('.pdft-page__canvas')).toBeVisible();
}

const row = (page: Page, name: RegExp) => page.getByRole('treeitem', { name });
const ids = (blocks: { id: string }[]) => blocks.map((b) => b.id);
type Saved = {
  document: {
    layers: { id: string; title?: string; pages: string; elements: Record<string, unknown>[] }[];
    body: { id: string }[];
    footer: { id: string }[];
  };
  expectedRevision?: number;
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
});

test('edits the structure with drag and drop and undo, draws a rectangle and saves a draft', async ({ page }) => {
  const world = newWorld();
  await open(page, world);

  // Selecting a block in the structure outlines it on the page and shows it in the properties pane.
  await row(page, /Introduction/).click();
  await expect(row(page, /Introduction/)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.pdft-outline--selected')).toHaveCount(1);
  await expect(page.getByTestId('properties-panel').getByLabel('Title in the structure')).toHaveValue('Introduction');

  // Drag the introduction into the footer, above the page number; Undo puts it back.
  const bodyCount = page.getByRole('treeitem', { name: /^Body/ }).locator('.pdft-count');
  const footerCount = page.getByRole('treeitem', { name: /^Footer/ }).locator('.pdft-count');
  await expect(bodyCount).toHaveText('3');
  await row(page, /Introduction/).dragTo(row(page, /Page number/), { targetPosition: { x: 60, y: 4 } });
  await expect(bodyCount).toHaveText('2');
  await expect(footerCount).toHaveText('2');
  await page.getByRole('button', { name: /^Undo/ }).click();
  await expect(bodyCount).toHaveText('3');
  await expect(footerCount).toHaveText('1');

  // Move the table instead, to the end of the footer (onto its section heading puts it first).
  await row(page, /Invoiced items/).dragTo(page.getByRole('treeitem', { name: /^Footer/ }), {
    targetPosition: { x: 60, y: 8 },
  });
  await expect(footerCount).toHaveText('2');

  // The Rectangle tool: pick it, then draw on the page.
  await page.getByRole('button', { name: 'Rectangle (R)' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'drag on the page to draw it' })).toBeVisible();
  const overlay = page.locator('.pdft-overlay').first();
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.7, { steps: 5 });
  await page.mouse.up();
  const layersCount = page.getByRole('treeitem', { name: /^Page layers/ }).locator('.pdft-count');
  await expect(layersCount).toHaveText('2');
  await expect(page.getByRole('status').filter({ hasText: 'drag on the page to draw it' })).toHaveCount(0);

  await expect(page.getByText(/Draft v1 · unsaved/)).toBeVisible();
  const request = page.waitForRequest(
    (r) => r.method() === 'PUT' && r.url().endsWith('/api/v1/pdf-templates/wiref/draft'),
  );
  await page.getByRole('button', { name: 'Save draft' }).click();
  const body = (await request).postDataJSON() as Saved;

  expect(ids(body.document.body)).toEqual(['title', 'intro']);
  expect(ids(body.document.footer)).toEqual(['items', 'pageno']);
  const drawn = body.document.layers.find((l) => l.title === 'Free elements · first page')!;
  expect(drawn.pages).toBe('first');
  expect(drawn.elements).toHaveLength(1);
  expect(drawn.elements[0]).toMatchObject({ type: 'rect', stroke: 0.3 });
  expect(drawn.elements[0].w as number).toBeGreaterThan(20);
  expect(drawn.elements[0].h as number).toBeGreaterThan(10);
  expect(body.expectedRevision).toBeUndefined();

  await expect(page.getByText('Draft v1', { exact: true })).toBeVisible();
  expectNoUnexpectedRequests(world);
});

test('publishes after saving the edits as the draft', async ({ page }) => {
  const published = versionOf(3, 'published', builtinDocument());
  const world = newWorld({ published, versions: [published] });
  await open(page, world);
  await expect(page.getByText('Published v3')).toBeVisible();

  await row(page, /Introduction/).click();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(page.getByText('Draft v4 · unsaved')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Publish' })).toBeEnabled();
  await page.getByRole('button', { name: 'Publish' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Publish version 4?' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByText('Published v4')).toBeVisible();

  expect(sent(world, 'PUT', '/pdf-templates/wiref/draft')).toHaveLength(1);
  expect(sent(world, 'POST', '/pdf-templates/wiref/publish')[0].body).toEqual({ expectedRevision: 1 });
  expectNoUnexpectedRequests(world);
});

test('keeps the editor usable when the preview fails and restores an older version as the draft', async ({ page }) => {
  const older = versionOf(1, 'archived', { ...builtinDocument(), name: 'Old layout' });
  const published = versionOf(2, 'published', builtinDocument());
  const world = newWorld({ published, versions: [published, older], previewFails: true });
  await installPdfTemplatesApi(page, world);
  await page.goto('/settings/pdf-templates');
  await expect(page.getByRole('treeitem', { name: /Page setup/ })).toBeVisible();
  await expect(page.getByText('The preview could not be rendered.')).toBeVisible();
  await expect(row(page, /Introduction/)).toBeVisible();

  await page.getByRole('button', { name: 'Versions' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('Version 2')).toBeVisible();
  await dialog.getByRole('button', { name: 'Restore as draft' }).click();
  await expect(page.getByText('Draft v3', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Old layout', level: 1 })).toBeVisible();
  expectNoUnexpectedRequests(world);
});

test('changes a table header background with a document colour and follows an edit of that colour', async ({
  page,
}) => {
  const world = newWorld();
  await open(page, world);
  await row(page, /Invoiced items/).click();
  const properties = page.getByTestId('properties-panel');
  const field = properties.getByRole('button', { name: /Header background: choose colour/ });
  await field.click();
  const picker = page.getByRole('dialog', { name: 'Colour' });
  await picker.getByRole('button', { name: 'HTU red' }).click();
  await expect(field).toContainText('HTU red');
  await expect(picker).toContainText('Linked to HTU red');
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);

  // Editing the document colour on the Styles tab changes the linked field, which is not stale.
  await page.getByRole('tab', { name: 'Styles' }).click();
  await page.getByRole('button', { name: 'Edit HTU red' }).click();
  const hex = page.getByRole('textbox', { name: 'Hex colour' });
  await hex.fill('#00ff00');
  await expect(page.getByTestId('styles-panel')).toContainText('1×');
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Properties' }).click();
  await expect(field).toContainText('#00FF00');

  const request = page.waitForRequest((r) => r.method() === 'PUT' && r.url().endsWith('/pdf-templates/wiref/draft'));
  await page.getByRole('button', { name: 'Save draft' }).click();
  const body = (await request).postDataJSON() as {
    document: { styles: { colors: { id: string; value: string }[] }; body: Record<string, unknown>[] };
  };
  expect(body.document.styles.colors.find((c) => c.id === 'red')?.value).toBe('#00ff00');
  expect(body.document.body.find((b) => b.id === 'items')).toMatchObject({ headerFill: '$c:red' });
  expectNoUnexpectedRequests(world);
});

test('inserts a variable from the Variables tab into the text field edited last', async ({ page }) => {
  await open(page, newWorld());
  await row(page, /Introduction/).click();
  const text = page.getByTestId('properties-panel').getByRole('textbox', { name: 'Text', exact: true });
  await text.click();
  await text.press('End');
  await page.getByRole('tab', { name: 'Variables' }).click();
  const variable = page.getByRole('button', { name: /request\.number/ });
  await expect(variable).toContainText('The request number.');
  await expect(variable).toContainText('e.g. IR-2026-0042');
  await variable.click();
  await expect(text).toHaveValue('Please issue an invoice to the recipient below.{{request.number}}');
  // A field of a list is written with the name of the loop over it.
  await page.getByRole('button', { name: /items\[\]\.description/ }).click();
  await expect(text).toHaveValue(/\{\{request\.number\}\}\{\{item\.description\}\}$/);
  await expect(page.getByText('Draft v1 · unsaved')).toBeVisible();
});

test('has no accessibility violations in the editor', async ({ page }) => {
  await open(page, newWorld());
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(results.violations.map((v) => ({ rule: v.id, targets: v.nodes.map((n) => n.target.join(' ')) }))).toEqual([]);
});
