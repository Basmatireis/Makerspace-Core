import { Link, Tile } from '@carbon/react';
import type { GlanceTile } from './glance';

export function GlanceTiles({ tiles, onSection }: { tiles: GlanceTile[]; onSection: (section: string) => void }) {
  return (
    <dl className="od-glance" aria-label="At a glance" data-guide="open-days-glance">
      {tiles.map((tile) => (
        <Tile key={tile.id} className={`od-glance__tile${tile.tone ? ` is-${tile.tone}` : ''}`}>
          <dt>{tile.label}</dt>
          <dd className="od-glance__value">
            {tile.value}
            {tile.unit && <small>{tile.unit}</small>}
          </dd>
          {tile.helper && (
            <dd className="od-glance__helper">
              {tile.helper}
              {tile.section && (
                <Link
                  href={`#${tile.section}`}
                  onClick={(event) => {
                    event.preventDefault();
                    onSection(tile.section ?? 'upcoming');
                  }}
                >
                  Show
                </Link>
              )}
            </dd>
          )}
        </Tile>
      ))}
    </dl>
  );
}
