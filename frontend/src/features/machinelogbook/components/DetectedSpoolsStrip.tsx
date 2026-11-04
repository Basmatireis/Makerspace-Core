import { Button, Tag } from '@carbon/react';
import { Add } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { DetectedSpoolTag, Material, MaterialType } from '../../../api/generated/models';
import { detectedGrams, detectedSlotText, matchLabel, suggestArticle } from '../detectedSpools';
import { materialTypesQuery } from '../inventoryQueries';
import { detectedSpoolTagsQuery } from '../queries';
import { useCan } from '../shared/useCan';
import { ColorSwatch, formatGrams } from './inventoryShared';
import { trayIdentityDisplay } from './spoolShared';

const tagKey = (tag: DetectedSpoolTag) => `${tag.machineId}:${tag.unitExternalId}:${tag.trayExternalId}`;

function DetectedRow({
  tag,
  materials,
  types,
  onRegister,
}: {
  tag: DetectedSpoolTag;
  materials: readonly Material[];
  types: readonly MaterialType[];
  onRegister?: (tag: DetectedSpoolTag) => void;
}) {
  const identity = trayIdentityDisplay(tag);
  const suggestion = suggestArticle(tag, materials, types);
  const grams = detectedGrams(tag, Number(suggestion.article?.packageSize ?? 0));
  const reported = [tag.subBrand ?? tag.materialType ?? 'Unknown filament'];
  // The reported colour next to the suggestion, so that a similar article can be compared with it.
  const reportedColor = suggestion.colorHex && (
    <>
      <ColorSwatch hex={suggestion.colorHex} name={`${suggestion.colorHex} reported`} />
      <span className="mj-secondary">{suggestion.colorHex} reported</span>
    </>
  );
  return (
    <li className="inv-detected__row">
      <div>
        <span className="inv-detected__key">{detectedSlotText(tag)}</span>
        <span className="inv-detected__value">
          <ColorSwatch hex={tag.colorHex ? `#${tag.colorHex}` : null} name="Reported colour" />
          <strong>{reported}</strong>
          {tag.colorHex && (
            <span className="mj-secondary">
              #{tag.colorHex}
              {suggestion.colorName ? ` ${suggestion.colorName}` : ''}
            </span>
          )}
        </span>
      </div>
      <div>
        <span className="inv-detected__key">Reported remaining</span>
        <span className="inv-detected__value">
          {tag.remainPercent == null ? 'Unknown' : `${tag.remainPercent} %`}
          {grams != null && <span className="mj-secondary">≈ {formatGrams(grams)}</span>}
        </span>
      </div>
      <div>
        <span className="inv-detected__key">{identity?.label ?? 'RFID'}</span>
        <span className="inv-detected__value inv-mono inv-detected__id" title={identity?.value}>
          {identity?.value}
        </span>
      </div>
      <div>
        <span className="inv-detected__key">Suggested article</span>
        <span className="inv-detected__value">
          {suggestion.article && suggestion.match ? (
            <>
              <ColorSwatch hex={suggestion.article.colorHex} name={suggestion.article.colorName} />
              <span className="inv-ellipsis">{suggestion.article.name}</span>
              <Tag type={suggestion.match === 'same' ? 'green' : 'blue'} size="sm">
                {matchLabel[suggestion.match]}
              </Tag>
              {reportedColor}
            </>
          ) : (
            <>
              <Tag type="purple" size="sm">
                New article
              </Tag>
              <span className="mj-secondary inv-ellipsis">
                {suggestion.type
                  ? `${suggestion.type.name} ${suggestion.variant}`.trim()
                  : `No type ${tag.materialType ?? ''}`}
              </span>
              {reportedColor}
            </>
          )}
        </span>
      </div>
      <div className="inv-detected__actions">
        {onRegister && (
          <Button kind="secondary" size="sm" renderIcon={Add} onClick={() => onRegister(tag)}>
            Register
          </Button>
        )}
      </div>
    </li>
  );
}

/**
 * Filament the printers report with an RFID tag that no active spool carries. Registering one suggests the article
 * from what the printer reports. Hidden without `machines.read`, while nothing is detected and when the request fails.
 */
export function DetectedSpoolsStrip({
  materials,
  onRegister,
}: {
  materials: readonly Material[];
  /** Offers Register per row; pass it only to people who may register spools. */
  onRegister?: (tag: DetectedSpoolTag) => void;
}) {
  const can = useCan();
  const allowed = can('machines.read') && can('inventory.read');
  const query = useQuery({ ...detectedSpoolTagsQuery(), enabled: allowed, refetchInterval: 30_000 });
  const types = useQuery({ ...materialTypesQuery(), enabled: allowed });
  const unregistered = (query.data?.items ?? []).filter((tag) => tag.spool === null);
  if (!allowed || unregistered.length === 0) return null;
  const machines = [...new Set(unregistered.map((tag) => tag.machineName))];
  return (
    <section className="inv-detected" aria-labelledby="inv-detected-title">
      <div className="inv-detected__head">
        <h2 id="inv-detected-title">Detected by printers, not registered</h2>
        <p>Filament whose RFID tag matches no spool. Register it to start tracking; the article is suggested.</p>
        <span className="mj-secondary">Live from {machines.join(' and ')}</span>
      </div>
      <ul>
        {unregistered.map((tag) => (
          <DetectedRow
            key={tagKey(tag)}
            tag={tag}
            materials={materials}
            types={types.data ?? []}
            onRegister={onRegister}
          />
        ))}
      </ul>
    </section>
  );
}
