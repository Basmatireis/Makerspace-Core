// Planned competencies of an open day as small outlined chips: public labels only, never who brings them. Plain
// React and CSS like the rest of the renderer, so the player can use it.

export function CompetencyChips({ labels, limit }: { labels: readonly string[]; limit: number }) {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, limit);
  return (
    <span className="sg-chips" aria-label="Planned support">
      {shown.map((label) => (
        <span key={label} className="sg-chip">
          {label}
        </span>
      ))}
      {labels.length > shown.length && <span className="sg-chip sg-chip--more">+{labels.length - shown.length}</span>}
    </span>
  );
}
