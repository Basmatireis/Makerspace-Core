import { Button, Tab, TabList, TabPanel, TabPanels, Tabs } from '@carbon/react';
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderRoute } from '../test/render';
import { PageShell } from './PageShell';

describe('PageShell', () => {
  it('renders the canonical header, content, breadcrumbs, and actions', async () => {
    const { container } = renderRoute(
      <PageShell
        title="Person details"
        description="Account and access information."
        breadcrumbs={[{ label: 'People', to: '/people' }, { label: 'Person details' }]}
        actions={<Button>Edit</Button>}
        width="wide"
      >
        <p>Page body</p>
      </PageShell>,
      '/people/person-1',
    );

    const shell = container.querySelector('[data-page-shell]');
    expect(shell).toHaveAttribute('data-page-width', 'wide');
    expect(shell).toHaveClass('page-shell--wide');
    expect(screen.getByRole('heading', { name: 'Person details', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Account and access information.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'People' })).toHaveAttribute('href', '/people');
    expect(screen.getByText('Person details', { selector: '[aria-current]' })).toHaveAttribute('aria-current', 'true');
    expect(within(screen.getByRole('banner')).getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(container.querySelector('.page-shell__content')).toHaveTextContent('Page body');
    await waitFor(() => expect(document.title).toBe('Person details · HTU Graz Makerspace'));
  });

  it('keeps the Carbon tab list in the header and tab panels in page content', () => {
    const { container } = renderRoute(
      <Tabs>
        <PageShell
          title="Tabbed page"
          tabs={<TabList aria-label="Page sections"><Tab>Overview</Tab><Tab>Access</Tab></TabList>}
        >
          <TabPanels>
            <TabPanel>Overview content</TabPanel>
            <TabPanel>Access content</TabPanel>
          </TabPanels>
        </PageShell>
      </Tabs>,
    );

    const header = screen.getByRole('banner');
    expect(within(header).getByRole('tablist', { name: 'Page sections' })).toBeInTheDocument();
    expect(header).not.toHaveTextContent('Overview content');
    expect(container.querySelector('.page-shell__content')).toHaveTextContent('Overview content');
  });

  it.each(['standard', 'wide', 'fluid'] as const)('exposes the %s width variant', (width) => {
    const { container } = renderRoute(<PageShell title="Width test" width={width}>Body</PageShell>);
    expect(container.querySelector('[data-page-shell]')).toHaveClass(`page-shell--${width}`);
  });
});
