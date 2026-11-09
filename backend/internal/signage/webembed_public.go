package signage

import (
	"context"
	"errors"
	"strings"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// noFrameAncestors is the frame-ancestors value for an unknown embed key: no website may frame the page.
const noFrameAncestors = "'none'"

// PublicEmbed is a web embed as its public endpoints see it, addressed by its embed key.
type PublicEmbed struct {
	ID             uuid.UUID
	Enabled        bool
	OpenDirectly   bool
	AspectRatio    AspectRatio
	AllowedOrigins []string
	ViewerLimit    int
	display        PlayerDisplay
}

// publicEmbed resolves an embed key; an unknown key is 404.
func (s *Service) publicEmbed(ctx context.Context, q *signagedb.Queries, key string) (PublicEmbed, error) {
	if !validEmbedKey(key) {
		return PublicEmbed{}, apperror.NotFound
	}
	row, err := q.GetSignageWebEmbedByKey(ctx, key)
	if errors.Is(err, pgx.ErrNoRows) {
		return PublicEmbed{}, apperror.NotFound
	}
	if err != nil {
		return PublicEmbed{}, err
	}
	switches, err := embedSwitchesOf(
		row.CameraEnabled, row.CameraMachineIds, row.TimelapseEnabled, row.TimelapseCount, row.TimelapseMaxAgeDays,
	)
	if err != nil {
		return PublicEmbed{}, err
	}
	ratio := aspectRatioOf(row.AspectWidth, row.AspectHeight)
	return PublicEmbed{
		ID: row.DisplayID, Enabled: row.Enabled, OpenDirectly: row.OpenDirectly, AspectRatio: ratio,
		AllowedOrigins: row.AllowedOrigins, ViewerLimit: int(row.CameraViewerLimit),
		// A web embed is always treated as visible from outside; it has no location.
		display: PlayerDisplay{
			ID: row.DisplayID, Name: row.Name, AspectRatio: ratio, VisibleFromOutside: true, embed: &switches,
		},
	}, nil
}

// enabledEmbed resolves an embed key for the content endpoints: unknown and switched-off embeds are both 404.
func (s *Service) enabledEmbed(ctx context.Context, q *signagedb.Queries, key string) (PublicEmbed, error) {
	embed, err := s.publicEmbed(ctx, q, key)
	if err != nil {
		return PublicEmbed{}, err
	}
	if !embed.Enabled {
		return PublicEmbed{}, apperror.NotFound
	}
	return embed, nil
}

func validEmbedKey(key string) bool {
	if len(key) < 20 || len(key) > 64 {
		return false
	}
	for _, r := range key {
		if (r < 'a' || r > 'z') && (r < 'A' || r > 'Z') && (r < '0' || r > '9') && r != '-' && r != '_' {
			return false
		}
	}
	return true
}

// EmbedFrameAncestors returns the CSP frame-ancestors value for an embed page: the allowed websites of a known key
// (switched on or off, so the neutral page may still be framed) and 'none' for an unknown one.
func (s *Service) EmbedFrameAncestors(ctx context.Context, key string) (string, error) {
	embed, err := s.publicEmbed(ctx, signagedb.New(s.pool), key)
	if errors.Is(err, apperror.NotFound) {
		return noFrameAncestors, nil
	}
	if err != nil {
		return "", err
	}
	// The origins were validated on write; the check again keeps anything else out of the header.
	origins := make([]string, 0, len(embed.AllowedOrigins))
	for _, origin := range embed.AllowedOrigins {
		if embedOriginPattern.MatchString(origin) {
			origins = append(origins, origin)
		}
	}
	if len(origins) == 0 {
		return noFrameAncestors, nil
	}
	return strings.Join(origins, " "), nil
}

// EmbedManifest returns the embed's settings and its latest publication, or unchanged when the page already runs
// revision known. A switched-off embed answers without a manifest. A request of a switched-on embed without a known
// revision is a page load and is counted. Scene, asset and custom-layout names stay out: the page renders without
// them, and they may describe internal content.
func (s *Service) EmbedManifest(
	ctx context.Context,
	key string,
	known *int,
) (embed PublicEmbed, manifest *Manifest, unchanged bool, err error) {
	q := signagedb.New(s.pool)
	embed, err = s.publicEmbed(ctx, q, key)
	if err != nil {
		return PublicEmbed{}, nil, false, err
	}
	if !embed.Enabled {
		return embed, nil, false, nil
	}
	if known == nil || *known == 0 {
		// Counted in memory and written by FlushEmbedLoads, so a page load never writes to the database.
		s.embedLoads.record(embed.ID, s.now())
	}
	latest, unchanged, err := s.PlayerManifest(ctx, embed.display, known)
	if err != nil || unchanged {
		return embed, nil, unchanged, err
	}
	return embed, publicManifest(latest), false, nil
}

// EmbedLive assembles the live data of a switched-on embed.
func (s *Service) EmbedLive(ctx context.Context, key string) (LiveData, error) {
	embed, err := s.enabledEmbed(ctx, signagedb.New(s.pool), key)
	if err != nil {
		return LiveData{}, err
	}
	return s.playerLive(ctx, embed.display, true)
}

// OpenEmbedAsset opens an asset of a switched-on embed's latest publication.
func (s *Service) OpenEmbedAsset(
	ctx context.Context,
	key string,
	assetID uuid.UUID,
	sha256 string,
) (PlayerAssetFile, error) {
	embed, err := s.enabledEmbed(ctx, signagedb.New(s.pool), key)
	if err != nil {
		return PlayerAssetFile{}, err
	}
	return s.OpenPlayerAsset(ctx, embed.display, assetID, sha256)
}

// OpenEmbedTimelapse opens a clip of a switched-on embed's current timelapse selection.
func (s *Service) OpenEmbedTimelapse(
	ctx context.Context,
	key string,
	runID uuid.UUID,
	sha256 string,
) (TimelapseFile, error) {
	embed, err := s.enabledEmbed(ctx, signagedb.New(s.pool), key)
	if err != nil {
		return TimelapseFile{}, err
	}
	return s.OpenPlayerTimelapse(ctx, embed.display, runID, sha256)
}

// EmbedCameraGrant is a camera a web embed may show right now, with the embed's viewer limit.
type EmbedCameraGrant struct {
	CameraGrant
	EmbedID     uuid.UUID
	ViewerLimit int
}

// AuthorizeEmbedCamera decides whether a web embed may show a machine's camera right now: the embed is switched on,
// its camera is switched on now and in its latest publication, the machine is chosen now and was then, and the camera
// rule of AuthorizeCamera holds. Unknown and switched-off embeds are 404; the rest answers like AuthorizeCamera.
func (s *Service) AuthorizeEmbedCamera(ctx context.Context, key string, machineID uuid.UUID) (EmbedCameraGrant, error) {
	embed, err := s.enabledEmbed(ctx, signagedb.New(s.pool), key)
	if err != nil {
		return EmbedCameraGrant{}, err
	}
	grant, err := s.authorizeDisplayCamera(ctx, embed.display, machineID)
	if err != nil {
		return EmbedCameraGrant{}, err
	}
	return EmbedCameraGrant{CameraGrant: grant, EmbedID: embed.ID, ViewerLimit: embed.ViewerLimit}, nil
}

// publicManifest is the manifest a web embed page gets: without the recorded media switches and without the names
// of scenes, assets and custom layouts, which only staff need.
func publicManifest(manifest Manifest) *Manifest {
	public := manifest
	public.EmbedMedia = nil
	public.Scenes = make([]ManifestScene, len(manifest.Scenes))
	for index, scene := range manifest.Scenes {
		scene.Name = ""
		public.Scenes[index] = scene
	}
	public.Assets = make([]ManifestAsset, len(manifest.Assets))
	for index, asset := range manifest.Assets {
		asset.Name = ""
		public.Assets[index] = asset
	}
	public.CustomLayouts = make([]ManifestCustomLayout, len(manifest.CustomLayouts))
	for index, layout := range manifest.CustomLayouts {
		layout.Name = ""
		public.CustomLayouts[index] = layout
	}
	return &public
}
