import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AttentionFlag, attentionColumn } from './AttentionFlag';
import { CardList, StackCard } from './CardList';
import { DetailPanel, DetailPanelHead, DetailPanelSection, PanelBleed } from './DetailPanel';
import { Fact, FactTiles, FactsGrid } from './Facts';
import { ListWithPanel, useListPanelLayout } from './ListWithPanel';

const originalMatchMedia = window.matchMedia;

function viewport(wide: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: wide && query === '(min-width: 66rem)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

function LayoutProbe() {
  return <p>{useListPanelLayout() ? 'panel' : 'pages'}</p>;
}

describe('ListWithPanel', () => {
  it('shows the panel next to the list from 1056 px on', () => {
    viewport(true);
    render(
      <ListWithPanel panel={<p>Spool S-1</p>} panelLabel="Spool details">
        <LayoutProbe />
      </ListWithPanel>,
    );
    expect(screen.getByRole('complementary', { name: 'Spool details' })).toHaveTextContent('Spool S-1');
    expect(screen.getByText('panel')).toBeInTheDocument();
  });

  it('leaves the panel out on narrower screens so rows open detail pages', () => {
    viewport(false);
    render(
      <ListWithPanel panel={<p>Spool S-1</p>} panelLabel="Spool details">
        <LayoutProbe />
      </ListWithPanel>,
    );
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    expect(screen.queryByText('Spool S-1')).not.toBeInTheDocument();
    expect(screen.getByText('pages')).toBeInTheDocument();
  });
});

describe('DetailPanel', () => {
  it('renders the four head lines, keeping empty ones, and sections with a bleeding table', () => {
    const { container } = render(
      <DetailPanel>
        <DetailPanelHead
          title="Bambu PLA Basic Black"
          titleId="panel-title"
          meta="Black · Bambu Lab"
          actions={<button type="button">Close panel</button>}
        />
        <DetailPanelSection title="Spools" action={<button type="button">Register spool</button>}>
          <PanelBleed>
            <table aria-label="Spools" />
          </PanelBleed>
        </DetailPanelSection>
      </DetailPanel>,
    );
    const heading = screen.getByRole('heading', { level: 2, name: 'Bambu PLA Basic Black' });
    expect(heading).toHaveAttribute('id', 'panel-title');
    expect(heading).toHaveAttribute('title', 'Bambu PLA Basic Black');
    expect(container.querySelector('.detail-panel__lines')?.children).toHaveLength(4);
    expect(screen.getByRole('heading', { level: 3, name: 'Spools' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register spool' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Spools' }).closest('.detail-panel__bleed')).not.toBeNull();
  });
});

describe('FactsGrid and FactTiles', () => {
  it('pairs each label with its value and helper', () => {
    render(
      <FactsGrid columns={3}>
        <Fact label="Remaining" helper="of 1000 g">
          640 g
        </Fact>
      </FactsGrid>,
    );
    const grid = screen.getByRole('term').closest('dl')!;
    expect(grid.style.getPropertyValue('--facts-columns')).toBe('3');
    expect(screen.getByRole('term')).toHaveTextContent('Remaining');
    expect(screen.getAllByRole('definition').map((node) => node.textContent)).toEqual(['640 g', 'of 1000 g']);
  });

  it('renders one tile per fact', () => {
    render(
      <FactTiles
        label="Article facts"
        items={[
          { label: 'In stock', value: '3.2 kg', helper: '4 spools' },
          { label: 'Value', value: '€ 82.40' },
        ]}
      />,
    );
    const strip = screen.getByLabelText('Article facts');
    expect(
      within(strip)
        .getAllByRole('term')
        .map((node) => node.textContent),
    ).toEqual(['In stock', 'Value']);
    expect(within(strip).getByText('4 spools')).toBeInTheDocument();
  });
});

describe('AttentionFlag', () => {
  it('renders nothing without reasons', () => {
    const { container } = render(<AttentionFlag attention={[]} />);
    expect(container).toBeEmptyDOMElement();
    render(<AttentionFlag attention={undefined} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('names every reason and shows them on focus', async () => {
    render(
      <AttentionFlag
        attention={[
          { code: 'low_stock', message: 'Below the reorder level' },
          { code: 'no_price', message: 'No price set' },
        ]}
      />,
    );
    const flag = screen.getByRole('button', { name: /Below the reorder level.*No price set/ });
    await userEvent.tab();
    expect(flag).toHaveFocus();
    expect(screen.getAllByRole('listitem').map((node) => node.textContent)).toEqual([
      'Below the reorder level',
      'No price set',
    ]);
  });

  it('describes a narrow, unsortable column', () => {
    expect(attentionColumn).toEqual({ key: 'attention', header: 'Needs attention', isSortable: false });
  });
});

describe('StackCard and CardList', () => {
  it('lists rows as links with a title, description and aside', () => {
    render(
      <MemoryRouter>
        <CardList
          title="Recent orders"
          count={2}
          action={<button type="button">All orders</button>}
          emptyText="No orders yet."
          items={[
            { id: 'o1', title: 'O-1 · Ada', description: '2 items', aside: <span>Paid</span>, to: '/orders/o1' },
            { id: 'o2', title: 'O-2 · Bob' },
          ]}
        />
      </MemoryRouter>,
    );
    const card = screen.getByRole('region', { name: /^Recent orders/ });
    expect(within(card).getByRole('link', { name: /O-1 · Ada/ })).toHaveAttribute('href', '/orders/o1');
    expect(within(card).getByText('O-2 · Bob').closest('a')).toBeNull();
    expect(within(card).getByRole('button', { name: 'All orders' })).toBeInTheDocument();
  });

  it('says so when there are no rows', () => {
    render(
      <MemoryRouter>
        <CardList title="Needs attention" emptyText="Nothing needs attention right now." items={[]} />
        <StackCard title="Totals">
          <p>€ 0</p>
        </StackCard>
      </MemoryRouter>,
    );
    expect(screen.getByText('Nothing needs attention right now.')).toBeInTheDocument();
    expect(screen.queryByRole('list')).not.toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Totals' })).toHaveTextContent('€ 0');
  });
});
