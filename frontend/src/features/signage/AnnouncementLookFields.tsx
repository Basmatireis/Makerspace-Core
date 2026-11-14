import type { SignageTone } from '../../api/generated/models';
import { announcementTextColor, TONE_COLORS } from './announcementLook';
import { ColorRow } from './editor/BlockStyleFields';
import { MediaPicker } from './MediaPicker';

/**
 * Background colour and image of an announcement. No colour means the tone's colour; the text colour is derived and
 * a colour that no text colour can be read on is flagged right away (the server checks it again).
 */
export function AnnouncementLookFields({
  idPrefix,
  tone,
  color,
  imageAssetId,
  serverError,
  onColorChange,
  onImageChange,
}: {
  idPrefix: string;
  tone: SignageTone;
  color: string | null;
  imageAssetId: string | null;
  /** The server's verdict on the colour (422), shown until the colour changes. */
  serverError?: string;
  onColorChange: (color: string | null) => void;
  onImageChange: (assetId: string | null) => void;
}) {
  const unreadable = color !== null && announcementTextColor(color) === null;
  const error = unreadable ? 'No text colour is readable on this colour. Pick a darker or lighter one.' : serverError;
  return (
    <div className="sg-look">
      <ColorRow
        id={`${idPrefix}-color`}
        label="Colour"
        value={color}
        clearLabel="Reset"
        emptyText="Tone colour"
        fallback={TONE_COLORS[tone]}
        onChange={onColorChange}
      />
      {error ? (
        <p className="sg-error-text" role="alert">
          {error}
        </p>
      ) : (
        <p className="sg-secondary">
          {color
            ? 'The text turns white or black, whichever is easier to read.'
            : 'Without a colour the announcement uses its tone colour.'}
        </p>
      )}
      <MediaPicker
        id={`${idPrefix}-image`}
        labelText="Background image"
        kind="image"
        value={imageAssetId}
        allowNone
        helperText="Fills the background; the colour lies over it at 70 % so the text stays readable."
        onChange={onImageChange}
      />
    </div>
  );
}
