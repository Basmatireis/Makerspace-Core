import { Button, IconButton, NumberInput, Select, SelectItem } from '@carbon/react';
import { Add, ArrowDown, ArrowUp, TrashCan } from '@carbon/icons-react';
import { useQuery } from '@tanstack/react-query';
import type { SignageAspectRatio, SignageTransition } from '../../api/generated/models';
import { SceneThumbnail } from './components';
import { loopSeconds } from './engine/playback';
import { formatLoop, sameRatio } from './helpers';
import { scenesQuery } from './queries';
import { MAX_SCENE_LIST_ITEMS, newSceneListItem, type SceneListDraftItem } from './sceneListDraft';

/**
 * Ordered list of scenes with seconds and transition (a display's default scenes or a rule's scenes). Controlled, so
 * it works inside a React Hook Form `Controller` as well as with plain state. Only scenes of the owner's aspect
 * ratio are offered.
 */
export function SceneListFields({
  idPrefix,
  value,
  onChange,
  aspectRatio,
  invalidText,
  label = 'Scenes',
}: {
  idPrefix: string;
  value: SceneListDraftItem[];
  onChange: (next: SceneListDraftItem[]) => void;
  aspectRatio: SignageAspectRatio;
  invalidText?: string;
  label?: string;
}) {
  const scenesResult = useQuery(scenesQuery());
  const all = scenesResult.data?.items ?? [];
  const matching = all.filter((scene) => sameRatio(scene.aspectRatio, aspectRatio));
  const single = value.length === 1;

  const patch = (index: number, change: Partial<SceneListDraftItem>) =>
    onChange(value.map((item, at) => (at === index ? { ...item, ...change } : item)));
  const move = (index: number, direction: -1 | 1) => {
    const next = [...value];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    onChange(next);
  };

  return (
    <fieldset className="sg-scene-list">
      <legend className="cds--label">{label}</legend>
      {value.map((item, index) => {
        const chosen = all.find((scene) => scene.id === item.sceneId);
        // A scene of another ratio stays visible so that the row does not look empty; the backend rejects it.
        const options = chosen && !matching.includes(chosen) ? [chosen, ...matching] : matching;
        return (
          // The list has no stable item ids; rows are only reordered through the buttons below.
          <div className="sg-scene-row" key={index}>
            <div className="sg-scene-row__thumb">{chosen && <SceneThumbnail scene={chosen} />}</div>
            <div className="sg-scene-row__fields">
              <Select
                id={`${idPrefix}-scene-${index}`}
                labelText={`Scene ${index + 1}`}
                hideLabel
                size="sm"
                value={item.sceneId}
                onChange={(event) => patch(index, { sceneId: event.target.value })}
              >
                <SelectItem value="" text={scenesResult.isPending ? 'Loading scenes…' : 'Choose a scene…'} />
                {options.map((scene) => (
                  <SelectItem key={scene.id} value={scene.id} text={scene.name} />
                ))}
              </Select>
              {!single && (
                <>
                  <NumberInput
                    id={`${idPrefix}-seconds-${index}`}
                    label="Seconds"
                    size="sm"
                    min={3}
                    max={3600}
                    value={item.seconds}
                    invalid={!(item.seconds >= 3 && item.seconds <= 3600)}
                    invalidText="3 to 3600"
                    onChange={(_, { value: next }) => {
                      const seconds = Number(next);
                      patch(index, {
                        seconds: next === '' || !Number.isFinite(seconds) ? Number.NaN : Math.round(seconds),
                      });
                    }}
                  />
                  <Select
                    id={`${idPrefix}-transition-${index}`}
                    labelText="Transition"
                    size="sm"
                    value={item.transition}
                    onChange={(event) => patch(index, { transition: event.target.value as SignageTransition })}
                  >
                    <SelectItem value="cut" text="Cut" />
                    <SelectItem value="fade" text="Fade" />
                  </Select>
                </>
              )}
              <div className="sg-scene-row__buttons">
                <IconButton
                  label="Move up"
                  kind="ghost"
                  size="sm"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp />
                </IconButton>
                <IconButton
                  label="Move down"
                  kind="ghost"
                  size="sm"
                  disabled={index === value.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown />
                </IconButton>
                <IconButton
                  label="Remove scene"
                  kind="ghost"
                  size="sm"
                  onClick={() => onChange(value.filter((_, at) => at !== index))}
                >
                  <TrashCan />
                </IconButton>
              </div>
            </div>
          </div>
        );
      })}
      {invalidText && (
        <p className="cds--form-requirement sg-scene-list__error" role="alert">
          {invalidText}
        </p>
      )}
      <div className="sg-scene-list__footer">
        <Button
          kind="tertiary"
          size="sm"
          renderIcon={Add}
          disabled={value.length >= MAX_SCENE_LIST_ITEMS}
          onClick={() => onChange([...value, newSceneListItem()])}
        >
          Add scene
        </Button>
        {value.length > 1 && (
          <span className="sg-secondary">
            Loop {formatLoop(loopSeconds(value.map((item) => ({ seconds: item.seconds }))))}
          </span>
        )}
      </div>
    </fieldset>
  );
}
