package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"image"
	"image/jpeg"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/files"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/httpapi"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/config"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/signage"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/storage"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

// signageActor creates a non-master account whose only permissions are the given ones.
func signageActor(
	t *testing.T,
	pool *pgxpool.Pool,
	suffix string,
	permissions ...authorization.Permission,
) (authorization.Principal, seededAccount) {
	t.Helper()
	ctx := testContext(t)
	account := seedAccount(t, pool, "signage-"+suffix, false)
	if len(permissions) > 0 {
		roleID := ids.New()
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO roles (id, name) VALUES ($1, $2)`,
			roleID,
			"Signage "+suffix,
		); err != nil {
			t.Fatal(err)
		}
		for _, permission := range permissions {
			if _, err := pool.Exec(
				ctx,
				`INSERT INTO role_permission_grants (id, role_id, permission_id) VALUES (uuidv7(), $1, $2)`,
				roleID,
				permission,
			); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO person_roles (person_id, role_id) VALUES ($1, $2)`,
			account.personID,
			roleID,
		); err != nil {
			t.Fatal(err)
		}
	}
	principal, err := authorization.LoadPermissionsFrom(
		ctx,
		pool,
		authorization.Principal{AccountID: account.accountID, PersonID: account.personID},
	)
	if err != nil {
		t.Fatal(err)
	}
	return principal, account
}

type signageFixture struct {
	pool    *pgxpool.Pool
	service *signage.Service
	store   *storage.Local
	admin   authorization.Principal
}

func newSignageFixture(t *testing.T) signageFixture {
	t.Helper()
	pool := migratedPool(t)
	store, err := storage.NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	service, err := signage.NewService(
		pool,
		config.Config{MakerspaceTimeZone: "Europe/Vienna"},
		files.NewService(pool, store),
	)
	if err != nil {
		t.Fatal(err)
	}
	account := seedAccount(t, pool, "signage-master", true)
	return signageFixture{
		pool:    pool,
		service: service,
		store:   store,
		admin:   authorization.Principal{AccountID: account.accountID, PersonID: account.personID, Master: true},
	}
}

func signageJPEG(t *testing.T, width, height int) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := jpeg.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, width, height)), nil); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}

func signageMP4(size int) []byte {
	data := make([]byte, size)
	copy(data, []byte{0, 0, 0, 0x18, 'f', 't', 'y', 'p', 'i', 's', 'o', 'm'})
	return data
}

func (f signageFixture) uploadImage(t *testing.T, name string) signage.Asset {
	t.Helper()
	asset, err := f.service.UploadAsset(
		testContext(t),
		f.admin,
		signage.UploadInput{Name: name, ContentType: "image/jpeg", Body: bytes.NewReader(signageJPEG(t, 64, 48))},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	return asset
}

func (f signageFixture) machine(t *testing.T, name string) uuid.UUID {
	t.Helper()
	typeID, machineID := ids.New(), ids.New()
	if _, err := f.pool.Exec(
		testContext(t),
		`INSERT INTO machine_types (id, name) VALUES ($1, $2)`,
		typeID,
		name+" type",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(
		testContext(t),
		`INSERT INTO machines (id, machine_type_id, name) VALUES ($1, $2, $3)`,
		machineID,
		typeID,
		name,
	); err != nil {
		t.Fatal(err)
	}
	return machineID
}

// display inserts a paired display (managed device included) that uses the given default playlist.
func (f signageFixture) display(t *testing.T, name string, playlistID uuid.UUID) uuid.UUID {
	t.Helper()
	ctx := testContext(t)
	typeID, deviceID, displayID := ids.New(), ids.New(), ids.New()
	if _, err := f.pool.Exec(
		ctx,
		`INSERT INTO device_types (id, name) VALUES ($1, $2)`,
		typeID,
		name+" type",
	); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(
		ctx,
		`INSERT INTO managed_devices (id, name, device_type_id, token_digest) VALUES ($1, $2, $3, decode(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''), 'hex'))`,
		deviceID,
		name,
		typeID,
	); err != nil {
		t.Fatal(err)
	}
	if _, err := f.pool.Exec(ctx, `INSERT INTO signage_displays (id, managed_device_id, name, location, orientation, resolution_width, resolution_height, default_playlist_id)
		VALUES ($1, $2, $3, 'Ground floor', 'landscape', 1920, 1080, $4)`, displayID, deviceID, name, playlistID); err != nil {
		t.Fatal(err)
	}
	return displayID
}

func emptyZonesJSON(ids ...string) map[string]json.RawMessage {
	zones := map[string]json.RawMessage{}
	for _, id := range ids {
		zones[id] = json.RawMessage(`{"type":"empty"}`)
	}
	return zones
}

func sceneInput(name string, layout string) signage.SceneInput {
	return signage.SceneInput{
		Name:            name,
		Orientation:     "landscape",
		LayoutID:        layout,
		BackgroundColor: "#101820",
		BackgroundFit:   "cover",
		BackgroundDim:   20,
		Theme:           "dark",
	}
}

func (f signageFixture) scene(t *testing.T, name string) signage.Scene {
	t.Helper()
	scene, err := f.service.CreateScene(testContext(t), f.admin, sceneInput(name, "full"), nil)
	if err != nil {
		t.Fatal(err)
	}
	return scene
}

func (f signageFixture) playlist(t *testing.T, name string, scenes ...uuid.UUID) signage.Playlist {
	t.Helper()
	items := make([]signage.PlaylistItem, 0, len(scenes))
	for _, id := range scenes {
		items = append(items, signage.PlaylistItem{SceneID: id, Seconds: 10, Transition: "cut"})
	}
	playlist, err := f.service.CreatePlaylist(
		testContext(t),
		f.admin,
		signage.PlaylistInput{Name: name, Items: items},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	return playlist
}

func expectInUse(t *testing.T, err error, kinds ...string) {
	t.Helper()
	var appErr *apperror.Error
	if !apperror.IsCode(err, "signage_in_use") {
		t.Fatalf("error = %v, want signage_in_use", err)
	}
	if !errors.As(err, &appErr) {
		t.Fatalf("error = %v, want apperror", err)
	}
	references, ok := appErr.Details["references"].([]map[string]any)
	if !ok || len(references) != len(kinds) {
		t.Fatalf("references = %#v, want kinds %v", appErr.Details["references"], kinds)
	}
	for index, kind := range kinds {
		if references[index]["kind"] != kind || references[index]["name"] == "" || references[index]["id"] == "" {
			t.Fatalf("reference %d = %#v, want kind %s", index, references[index], kind)
		}
	}
}

func TestSignagePermissionsAllowedAndDenied(t *testing.T) {
	f := newSignageFixture(t)
	ctx := testContext(t)
	nobody, _ := signageActor(t, f.pool, "nobody")
	reader, _ := signageActor(t, f.pool, "reader", authorization.SignageRead)
	content, _ := signageActor(t, f.pool, "content", authorization.SignageContentManage)
	override, _ := signageActor(t, f.pool, "override", authorization.SignageOverride)
	manager, _ := signageActor(
		t,
		f.pool,
		"manager",
		authorization.SignageManage,
		authorization.SignagePublish,
		authorization.LocalServicesManage,
	)

	asset := f.uploadImage(t, "seed.jpg")
	scene := f.scene(t, "Seed scene")
	playlist := f.playlist(t, "Seed playlist", scene.ID)
	template, err := f.service.CreateTemplate(
		ctx,
		f.admin,
		signage.TemplateInput{Name: "Seed", Tone: "info", Title: "Hello", Body: ""},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	announcement, err := f.service.StartAnnouncement(
		ctx,
		f.admin,
		signage.AnnouncementInput{TemplateID: template.ID, AllDisplays: true},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}

	type operation struct {
		name    string
		allowed authorization.Principal
		denied  []authorization.Principal
		run     func(authorization.Principal) error
	}
	upload := func(p authorization.Principal) error {
		_, err := f.service.UploadAsset(
			ctx,
			p,
			signage.UploadInput{Name: "x.jpg", ContentType: "image/jpeg", Body: bytes.NewReader(signageJPEG(t, 8, 8))},
			nil,
		)
		return err
	}
	operations := []operation{
		{
			"list layouts",
			reader,
			[]authorization.Principal{nobody, content, override, manager},
			func(p authorization.Principal) error { _, err := f.service.ListLayouts(ctx, p); return err },
		},
		{
			"list assets",
			reader,
			[]authorization.Principal{nobody, content, override, manager},
			func(p authorization.Principal) error { _, err := f.service.ListAssets(ctx, p, nil); return err },
		},
		{
			"get asset",
			reader,
			[]authorization.Principal{nobody, content},
			func(p authorization.Principal) error { _, err := f.service.GetAsset(ctx, p, asset.ID); return err },
		},
		{
			"open asset bytes",
			reader,
			[]authorization.Principal{nobody, content, override},
			func(p authorization.Principal) error {
				opened, err := f.service.OpenAsset(ctx, p, asset.ID)
				if err == nil {
					opened.Reader.Close()
				}
				return err
			},
		},
		{"upload asset", content, []authorization.Principal{nobody, reader, override, manager}, upload},
		{
			"rename asset",
			content,
			[]authorization.Principal{nobody, reader, override, manager},
			func(p authorization.Principal) error {
				_, err := f.service.RenameAsset(ctx, p, asset.ID, "renamed.jpg", nil)
				return err
			},
		},
		{
			"list scenes",
			reader,
			[]authorization.Principal{nobody, content},
			func(p authorization.Principal) error { _, err := f.service.ListScenes(ctx, p); return err },
		},
		{
			"get scene",
			reader,
			[]authorization.Principal{nobody, content},
			func(p authorization.Principal) error { _, err := f.service.GetScene(ctx, p, scene.ID); return err },
		},
		{
			"create scene",
			content,
			[]authorization.Principal{nobody, reader, override, manager},
			func(p authorization.Principal) error {
				_, err := f.service.CreateScene(ctx, p, sceneInput("Permission scene", "full"), nil)
				return err
			},
		},
		{
			"update scene",
			content,
			[]authorization.Principal{nobody, reader, override, manager},
			func(p authorization.Principal) error {
				_, err := f.service.UpdateScene(ctx, p, scene.ID, 99, sceneInput("Seed scene", "full"), nil)
				if apperror.IsCode(err, "stale_write") {
					return nil
				}
				return err
			},
		},
		{
			"list playlists",
			reader,
			[]authorization.Principal{nobody, content},
			func(p authorization.Principal) error { _, err := f.service.ListPlaylists(ctx, p); return err },
		},
		{"get playlist", reader, []authorization.Principal{nobody, content}, func(p authorization.Principal) error {
			_, err := f.service.GetPlaylist(ctx, p, playlist.ID)
			return err
		}},
		{
			"create playlist",
			content,
			[]authorization.Principal{nobody, reader, override, manager},
			func(p authorization.Principal) error {
				_, err := f.service.CreatePlaylist(ctx, p, signage.PlaylistInput{Name: "Permission playlist"}, nil)
				return err
			},
		},
		{
			"update playlist",
			content,
			[]authorization.Principal{nobody, reader, override, manager},
			func(p authorization.Principal) error {
				_, err := f.service.UpdatePlaylist(
					ctx,
					p,
					playlist.ID,
					99,
					signage.PlaylistInput{Name: "Seed playlist"},
					nil,
				)
				if apperror.IsCode(err, "stale_write") {
					return nil
				}
				return err
			},
		},
		{
			"list templates",
			reader,
			[]authorization.Principal{nobody, content, override},
			func(p authorization.Principal) error { _, err := f.service.ListTemplates(ctx, p); return err },
		},
		{
			"get template",
			reader,
			[]authorization.Principal{nobody, content, override},
			func(p authorization.Principal) error {
				_, err := f.service.GetTemplate(ctx, p, template.ID)
				return err
			},
		},
		{
			"create template",
			content,
			[]authorization.Principal{nobody, reader, override, manager},
			func(p authorization.Principal) error {
				_, err := f.service.CreateTemplate(
					ctx,
					p,
					signage.TemplateInput{Name: "Permission template", Tone: "info", Title: "T"},
					nil,
				)
				return err
			},
		},
		{
			"update template",
			content,
			[]authorization.Principal{nobody, reader, override, manager},
			func(p authorization.Principal) error {
				_, err := f.service.UpdateTemplate(
					ctx,
					p,
					template.ID,
					99,
					signage.TemplateInput{Name: "Seed", Tone: "info", Title: "Hello"},
					nil,
				)
				if apperror.IsCode(err, "stale_write") {
					return nil
				}
				return err
			},
		},
		{
			"list announcements",
			reader,
			[]authorization.Principal{nobody, content, override},
			func(p authorization.Principal) error { _, err := f.service.ListAnnouncements(ctx, p); return err },
		},
		{
			"get announcement",
			reader,
			[]authorization.Principal{nobody, content, override},
			func(p authorization.Principal) error {
				_, err := f.service.GetAnnouncement(ctx, p, announcement.ID)
				return err
			},
		},
		{
			"start announcement",
			override,
			[]authorization.Principal{nobody, reader, content, manager},
			func(p authorization.Principal) error {
				_, err := f.service.StartAnnouncement(
					ctx,
					p,
					signage.AnnouncementInput{TemplateID: template.ID, AllDisplays: true},
					nil,
				)
				return err
			},
		},
		{
			"edit announcement",
			override,
			[]authorization.Principal{nobody, reader, content, manager},
			func(p authorization.Principal) error {
				startsAt := time.Now()
				_, err := f.service.UpdateAnnouncement(
					ctx,
					p,
					announcement.ID,
					99,
					signage.AnnouncementInput{AllDisplays: true, StartsAt: &startsAt},
					nil,
				)
				if apperror.IsCode(err, "stale_write") {
					return nil
				}
				return err
			},
		},
		{
			"stop announcement",
			override,
			[]authorization.Principal{nobody, reader, content, manager},
			func(p authorization.Principal) error {
				err := f.service.StopAnnouncement(ctx, p, announcement.ID, 99, nil)
				if apperror.IsCode(err, "stale_write") {
					return nil
				}
				return err
			},
		},
		{
			"delete scene",
			content,
			[]authorization.Principal{nobody, reader, override, manager},
			func(p authorization.Principal) error {
				err := f.service.DeleteScene(ctx, p, scene.ID, 99, nil)
				if apperror.IsCode(err, "stale_write") {
					return nil
				}
				return err
			},
		},
		{
			"delete playlist",
			content,
			[]authorization.Principal{nobody, reader, override, manager},
			func(p authorization.Principal) error {
				err := f.service.DeletePlaylist(ctx, p, playlist.ID, 99, nil)
				if apperror.IsCode(err, "stale_write") {
					return nil
				}
				return err
			},
		},
		{
			"delete template",
			content,
			[]authorization.Principal{nobody, reader, override, manager},
			func(p authorization.Principal) error {
				err := f.service.DeleteTemplate(ctx, p, template.ID, 99, nil)
				if apperror.IsCode(err, "stale_write") {
					return nil
				}
				return err
			},
		},
		{
			"delete asset",
			content,
			[]authorization.Principal{nobody, reader, override, manager},
			func(p authorization.Principal) error {
				// The asset is referenced below, so an allowed caller is refused with signage_in_use rather than permission_denied.
				err := f.service.DeleteAsset(ctx, p, asset.ID, nil)
				if apperror.IsCode(err, "signage_in_use") {
					return nil
				}
				return err
			},
		},
	}
	// Reference the asset so the allowed delete does not remove it before other checks.
	referencing := sceneInput("Uses asset", "full")
	referencing.BackgroundAssetID = &asset.ID
	if _, err := f.service.CreateScene(ctx, f.admin, referencing, nil); err != nil {
		t.Fatal(err)
	}
	for _, op := range operations {
		if err := op.run(op.allowed); err != nil {
			t.Errorf("%s: allowed caller failed: %v", op.name, err)
		}
		for index, denied := range op.denied {
			if err := op.run(denied); !apperror.IsCode(err, "permission_denied") {
				t.Errorf("%s: denied caller %d got %v, want permission_denied", op.name, index, err)
			}
		}
	}
	// Master is allowed everywhere without any grant.
	if _, err := f.service.ListLayouts(ctx, f.admin); err != nil {
		t.Fatal(err)
	}
}

func TestSignageAssetsUploadValidationDownloadAndReferenceBlockedDelete(t *testing.T) {
	f := newSignageFixture(t)
	ctx := testContext(t)

	imageBytes := signageJPEG(t, 64, 48)
	asset, err := f.service.UploadAsset(
		ctx,
		f.admin,
		signage.UploadInput{Name: " Poster.jpg ", ContentType: "image/jpeg", Body: bytes.NewReader(imageBytes)},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if asset.Kind != "image" || asset.Name != "Poster.jpg" || asset.Width == nil || *asset.Width != 64 ||
		*asset.Height != 48 ||
		asset.DurationMs != nil ||
		asset.SizeBytes != int64(len(imageBytes)) ||
		len(asset.SHA256) != 64 ||
		asset.ContentType != "image/jpeg" {
		t.Fatalf("asset = %#v", asset)
	}
	opened, err := f.service.OpenAsset(ctx, f.admin, asset.ID)
	if err != nil {
		t.Fatal(err)
	}
	served, _ := io.ReadAll(opened.Reader)
	opened.Reader.Close()
	if !bytes.Equal(served, imageBytes) {
		t.Fatal("downloaded bytes differ from the upload")
	}

	width, height, duration := 1920, 1080, 90000
	video, err := f.service.UploadAsset(
		ctx,
		f.admin,
		signage.UploadInput{
			Name:        "Loop.mp4",
			ContentType: "video/mp4",
			Width:       &width,
			Height:      &height,
			DurationMs:  &duration,
			Body:        bytes.NewReader(signageMP4(3 << 20)),
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if video.Kind != "video" || *video.Width != 1920 || *video.DurationMs != 90000 || video.SizeBytes != 3<<20 {
		t.Fatalf("video = %#v", video)
	}
	bare, err := f.service.UploadAsset(
		ctx,
		f.admin,
		signage.UploadInput{Name: "Bare.mp4", ContentType: "video/mp4", Body: bytes.NewReader(signageMP4(64))},
		nil,
	)
	if err != nil || bare.Width != nil || bare.Height != nil || bare.DurationMs != nil {
		t.Fatalf("video without dimensions = %#v, %v", bare, err)
	}
	zero := 0
	negative := -3
	for name, input := range map[string]signage.UploadInput{
		"zero video width": {
			Name:        "v.mp4",
			ContentType: "video/mp4",
			Width:       &zero,
			Height:      &height,
			Body:        bytes.NewReader(signageMP4(64)),
		},
		"negative video duration": {
			Name:        "v.mp4",
			ContentType: "video/mp4",
			DurationMs:  &negative,
			Body:        bytes.NewReader(signageMP4(64)),
		},
		"width without height": {
			Name:        "v.mp4",
			ContentType: "video/mp4",
			Width:       &width,
			Body:        bytes.NewReader(signageMP4(64)),
		},
		"not an mp4":       {Name: "v.mp4", ContentType: "video/mp4", Body: bytes.NewReader(imageBytes)},
		"jpeg as png":      {Name: "p.png", ContentType: "image/png", Body: bytes.NewReader(imageBytes)},
		"garbage image":    {Name: "p.jpg", ContentType: "image/jpeg", Body: strings.NewReader("not an image")},
		"unsupported type": {Name: "p.gif", ContentType: "image/gif", Body: bytes.NewReader(imageBytes)},
		"empty":            {Name: "p.jpg", ContentType: "image/jpeg", Body: bytes.NewReader(nil)},
		"blank name":       {Name: "  ", ContentType: "image/jpeg", Body: bytes.NewReader(imageBytes)},
	} {
		if _, err := f.service.UploadAsset(ctx, f.admin, input, nil); !apperror.IsCode(err, "validation_failed") {
			t.Errorf("%s: error = %v, want validation_failed", name, err)
		}
	}
	oversize := bytes.NewReader(make([]byte, signage.MaxImageBytes+1))
	if _, err := f.service.UploadAsset(
		ctx,
		f.admin,
		signage.UploadInput{Name: "huge.png", ContentType: "image/png", Body: oversize},
		nil,
	); !apperror.IsCode(
		err,
		"signage_asset_too_large",
	) {
		t.Fatalf("oversize image error = %v", err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM signage_assets`, 3)
	assertCount(t, f.pool, `SELECT count(*) FROM files`, 3)

	renamed, err := f.service.RenameAsset(ctx, f.admin, asset.ID, "Welcome poster", nil)
	if err != nil || renamed.Name != "Welcome poster" {
		t.Fatalf("rename = %#v, %v", renamed, err)
	}
	if _, err := f.service.RenameAsset(ctx, f.admin, ids.New(), "x", nil); !apperror.IsCode(
		err,
		"not_found",
	) {
		t.Fatalf("rename unknown: %v", err)
	}
	images, err := f.service.ListAssets(ctx, f.admin, ptr(signage.AssetKindImage))
	if err != nil || len(images) != 1 || images[0].ID != asset.ID {
		t.Fatalf("image list = %#v, %v", images, err)
	}
	all, err := f.service.ListAssets(ctx, f.admin, nil)
	if err != nil || len(all) != 3 {
		t.Fatalf("asset list = %d, %v", len(all), err)
	}

	// An asset used as a scene background or inside a widget cannot be deleted.
	background := sceneInput("Background user", "full")
	background.BackgroundAssetID = &asset.ID
	backgroundScene, err := f.service.CreateScene(ctx, f.admin, background, nil)
	if err != nil {
		t.Fatal(err)
	}
	widgetScene := sceneInput("Widget user", "split")
	widgetScene.Zones = map[string]json.RawMessage{
		"left": json.RawMessage(`{"type":"video","mediaId":"` + video.ID.String() + `","fit":"cover"}`),
	}
	widgetUser, err := f.service.CreateScene(ctx, f.admin, widgetScene, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectInUse(t, f.service.DeleteAsset(ctx, f.admin, asset.ID, nil), "scene")
	expectInUse(t, f.service.DeleteAsset(ctx, f.admin, video.ID, nil), "scene")
	assertCount(t, f.pool, `SELECT count(*) FROM signage_assets`, 3)

	if err := f.service.DeleteScene(ctx, f.admin, backgroundScene.ID, backgroundScene.Version, nil); err != nil {
		t.Fatal(err)
	}
	if err := f.service.DeleteAsset(ctx, f.admin, asset.ID, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM signage_assets WHERE id=$1`, 0, asset.ID)
	assertCount(t, f.pool, `SELECT count(*) FROM files`, 2)
	if _, err := f.service.GetAsset(ctx, f.admin, asset.ID); !apperror.IsCode(err, "not_found") {
		t.Fatalf("deleted asset readable: %v", err)
	}
	if err := f.service.DeleteScene(ctx, f.admin, widgetUser.ID, widgetUser.Version, nil); err != nil {
		t.Fatal(err)
	}
	if err := f.service.DeleteAsset(ctx, f.admin, video.ID, nil); err != nil {
		t.Fatal(err)
	}
	if err := f.service.DeleteAsset(ctx, f.admin, video.ID, nil); !apperror.IsCode(err, "not_found") {
		t.Fatalf("second delete: %v", err)
	}

	// Audit rows carry field names only, never the original file name.
	var fields []string
	var metadata string
	if err := f.pool.QueryRow(
		ctx,
		`SELECT changed_fields, metadata::text FROM audit_events WHERE action='signage_asset.created' ORDER BY occurred_at LIMIT 1`,
	).Scan(&fields, &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata != "{}" || strings.Contains(strings.Join(fields, ","), "Poster") {
		t.Fatalf("audit leaks content: %v %s", fields, metadata)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM audit_events WHERE action='signage_asset.deleted'`, 2)
}

func ptr[T any](value T) *T { return &value }

func TestSignageScenesValidationConcurrencyLayoutChangeAndReferences(t *testing.T) {
	f := newSignageFixture(t)
	ctx := testContext(t)
	image := f.uploadImage(t, "pic.jpg")
	video, err := f.service.UploadAsset(
		ctx,
		f.admin,
		signage.UploadInput{Name: "v.mp4", ContentType: "video/mp4", Body: bytes.NewReader(signageMP4(64))},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	machine := f.machine(t, "Printer A")
	template, err := f.service.CreateTemplate(
		ctx,
		f.admin,
		signage.TemplateInput{Name: "T", Tone: "info", Title: "Hi"},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}

	input := sceneInput("Lobby", "split")
	input.Zones = map[string]json.RawMessage{
		"left": json.RawMessage(`{"type":"image","mediaId":"` + image.ID.String() + `","fit":"cover"}`),
		"right": json.RawMessage(
			`{"type":"status","machineIds":["` + machine.String() + `"],"showProgress":true,"showRemaining":false}`,
		),
	}
	scene, err := f.service.CreateScene(ctx, f.admin, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	if scene.Version != 1 || scene.LayoutID != "split" || len(scene.Zones) != 2 || scene.BackgroundAssetID != nil {
		t.Fatalf("scene = %#v", scene)
	}
	read, err := f.service.GetScene(ctx, f.admin, scene.ID)
	if err != nil || string(read.Zones["left"]) != string(scene.Zones["left"]) {
		t.Fatalf("read = %#v, %v", read, err)
	}
	blank, err := f.service.CreateScene(ctx, f.admin, sceneInput("Blank", "grid2x2"), nil)
	if err != nil || len(blank.Zones) != 4 || string(blank.Zones["br"]) != `{"type":"empty"}` {
		t.Fatalf("blank scene = %#v, %v", blank, err)
	}

	invalid := map[string]struct {
		change func(*signage.SceneInput)
	}{
		"unknown layout":        {func(i *signage.SceneInput) { i.LayoutID = "carousel" }},
		"bad orientation":       {func(i *signage.SceneInput) { i.Orientation = "square" }},
		"bad colour":            {func(i *signage.SceneInput) { i.BackgroundColor = "red" }},
		"upper-case colour":     {func(i *signage.SceneInput) { i.BackgroundColor = "#ABCDEF" }},
		"dim too high":          {func(i *signage.SceneInput) { i.BackgroundDim = 81 }},
		"bad theme":             {func(i *signage.SceneInput) { i.Theme = "blue" }},
		"empty name":            {func(i *signage.SceneInput) { i.Name = " " }},
		"zone not in layout":    {func(i *signage.SceneInput) { i.Zones = emptyZonesJSON("main") }},
		"background is a video": {func(i *signage.SceneInput) { i.BackgroundAssetID = &video.ID }},
		"background missing": {
			func(i *signage.SceneInput) { missing := ids.New(); i.BackgroundAssetID = &missing },
		},
		"image widget uses video": {func(i *signage.SceneInput) {
			i.Zones = map[string]json.RawMessage{
				"left": json.RawMessage(`{"type":"image","mediaId":"` + video.ID.String() + `","fit":"cover"}`),
			}
		}},
		"video widget uses image": {func(i *signage.SceneInput) {
			i.Zones = map[string]json.RawMessage{
				"left": json.RawMessage(`{"type":"video","mediaId":"` + image.ID.String() + `","fit":"cover"}`),
			}
		}},
		"missing machine": {func(i *signage.SceneInput) {
			i.Zones = map[string]json.RawMessage{
				"left": json.RawMessage(
					`{"type":"status","machineIds":["` + ids.New().
						String() +
						`"],"showProgress":true,"showRemaining":true}`,
				),
			}
		}},
		"missing template": {func(i *signage.SceneInput) {
			i.Zones = map[string]json.RawMessage{
				"left": json.RawMessage(
					`{"type":"announcement","templateIds":["` + ids.New().
						String() +
						`"],"style":"card","size":"m","whenNone":"empty","fallbackText":"","whenMany":"rotate","rotateSeconds":10}`,
				),
			}
		}},
		"http qr": {func(i *signage.SceneInput) {
			i.Zones = map[string]json.RawMessage{
				"left": json.RawMessage(`{"type":"qr","url":"http://insecure.example","caption":""}`),
			}
		}},
		"unknown widget field": {func(i *signage.SceneInput) {
			i.Zones = map[string]json.RawMessage{"left": json.RawMessage(`{"type":"clock","mode":"time","script":"x"}`)}
		}},
	}
	for name, item := range invalid {
		candidate := sceneInput("Candidate", "split")
		item.change(&candidate)
		if _, err := f.service.CreateScene(ctx, f.admin, candidate, nil); !apperror.IsCode(err, "validation_failed") {
			t.Errorf("create %s: error = %v, want validation_failed", name, err)
		}
		if _, err := f.service.UpdateScene(ctx, f.admin, scene.ID, scene.Version, candidate, nil); !apperror.IsCode(
			err,
			"validation_failed",
		) {
			t.Errorf("update %s: error = %v, want validation_failed", name, err)
		}
	}
	assertCount(t, f.pool, `SELECT count(*) FROM signage_scenes`, 2)

	// A widget that filters announcements by template makes the template undeletable.
	filtered := sceneInput("Announcer", "full")
	filtered.Zones = map[string]json.RawMessage{
		"main": json.RawMessage(
			`{"type":"announcement","templateIds":["` + template.ID.String() + `"],"style":"card","size":"m","whenNone":"empty","fallbackText":"","whenMany":"rotate","rotateSeconds":10}`,
		),
	}
	announcer, err := f.service.CreateScene(ctx, f.admin, filtered, nil)
	if err != nil {
		t.Fatal(err)
	}
	expectInUse(t, f.service.DeleteTemplate(ctx, f.admin, template.ID, template.Version, nil), "scene")
	if err := f.service.DeleteScene(ctx, f.admin, announcer.ID, announcer.Version, nil); err != nil {
		t.Fatal(err)
	}

	// Optimistic concurrency.
	renamed := sceneInput("Lobby renamed", "split")
	updated, err := f.service.UpdateScene(ctx, f.admin, scene.ID, scene.Version, renamed, nil)
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != 2 || updated.Name != "Lobby renamed" ||
		string(updated.Zones["left"]) != string(scene.Zones["left"]) {
		t.Fatalf("update without zones must keep widgets: %#v", updated)
	}
	if _, err := f.service.UpdateScene(ctx, f.admin, scene.ID, scene.Version, renamed, nil); !apperror.IsCode(
		err,
		"stale_write",
	) {
		t.Fatalf("stale update: %v", err)
	}
	if err := f.service.DeleteScene(ctx, f.admin, scene.ID, scene.Version, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale delete: %v", err)
	}
	if _, err := f.service.UpdateScene(ctx, f.admin, ids.New(), 1, renamed, nil); !apperror.IsCode(
		err,
		"not_found",
	) {
		t.Fatalf("unknown scene: %v", err)
	}
	if _, err := f.service.UpdateScene(ctx, f.admin, scene.ID, 0, renamed, nil); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("zero version: %v", err)
	}

	// Changing the layout without new zones keeps widgets by position.
	moved := sceneInput("Lobby renamed", "stack3")
	remapped, err := f.service.UpdateScene(ctx, f.admin, scene.ID, updated.Version, moved, nil)
	if err != nil {
		t.Fatal(err)
	}
	if remapped.LayoutID != "stack3" || string(remapped.Zones["header"]) != string(updated.Zones["left"]) ||
		string(remapped.Zones["main"]) != string(updated.Zones["right"]) ||
		string(remapped.Zones["footer"]) != `{"type":"empty"}` {
		t.Fatalf("remapped zones = %v", remapped.Zones)
	}
	if _, ok := remapped.Zones["left"]; ok {
		t.Fatal("old zone ids survived the layout change")
	}
	// Explicit zones for a new layout are validated against it and replace the old ones.
	explicit := sceneInput("Lobby renamed", "main_footer")
	explicit.Zones = emptyZonesJSON("main", "footer")
	replaced, err := f.service.UpdateScene(ctx, f.admin, scene.ID, remapped.Version, explicit, nil)
	if err != nil || len(replaced.Zones) != 2 || string(replaced.Zones["main"]) != `{"type":"empty"}` {
		t.Fatalf("explicit zones = %#v, %v", replaced, err)
	}

	// Playlists block scene deletion, and so do rules.
	playlist := f.playlist(t, "Loop", scene.ID)
	scene, _ = f.service.GetScene(ctx, f.admin, scene.ID)
	expectInUse(t, f.service.DeleteScene(ctx, f.admin, scene.ID, scene.Version, nil), "playlist")
	display := f.display(t, "Entrance", playlist.ID)
	ruleScene := f.scene(t, "Rule target")
	if _, err := f.pool.Exec(ctx, `INSERT INTO signage_rules (id, display_id, position, condition_kind, weekdays, time_from, time_to, target_kind, target_scene_id)
		VALUES (uuidv7(), $1, 0, 'time_window', '{1,2,3}', '08:00', '12:00', 'scene', $2)`, display, ruleScene.ID); err != nil {
		t.Fatal(err)
	}
	expectInUse(t, f.service.DeleteScene(ctx, f.admin, ruleScene.ID, ruleScene.Version, nil), "display_rule")
	if _, err := f.pool.Exec(ctx, `DELETE FROM signage_rules`); err != nil {
		t.Fatal(err)
	}
	if err := f.service.DeleteScene(ctx, f.admin, ruleScene.ID, ruleScene.Version, nil); err != nil {
		t.Fatal(err)
	}
	for _, action := range []string{"signage_scene.created", "signage_scene.updated", "signage_scene.deleted"} {
		var count int
		if err := f.pool.QueryRow(
			ctx,
			`SELECT count(*) FROM audit_events WHERE action=$1`,
			action,
		).Scan(&count); err != nil ||
			count == 0 {
			t.Fatalf("no audit row for %s (%v)", action, err)
		}
	}
	var fields []string
	var metadata string
	if err := f.pool.QueryRow(
		ctx,
		`SELECT changed_fields, metadata::text FROM audit_events WHERE action='signage_scene.updated' ORDER BY occurred_at LIMIT 1`,
	).Scan(&fields, &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata != "{}" || strings.Contains(strings.Join(fields, ","), "Lobby") {
		t.Fatalf("scene audit leaks content: %v %s", fields, metadata)
	}
}

func TestSignagePlaylistsReplaceItemsAtomicallyAndGuardDeletion(t *testing.T) {
	f := newSignageFixture(t)
	ctx := testContext(t)
	one, two, three := f.scene(t, "One"), f.scene(t, "Two"), f.scene(t, "Three")

	playlist, err := f.service.CreatePlaylist(
		ctx,
		f.admin,
		signage.PlaylistInput{Name: "Morning", Items: []signage.PlaylistItem{
			{SceneID: one.ID, Seconds: 10, Transition: "cut"}, {SceneID: two.ID, Seconds: 20, Transition: "fade"},
		}},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if playlist.Version != 1 || len(playlist.Items) != 2 || playlist.Items[1].SceneID != two.ID ||
		playlist.Items[1].Transition != "fade" {
		t.Fatalf("playlist = %#v", playlist)
	}
	// The same scene may appear twice; order is the item order.
	reordered, err := f.service.UpdatePlaylist(
		ctx,
		f.admin,
		playlist.ID,
		playlist.Version,
		signage.PlaylistInput{Name: "Morning loop", Items: []signage.PlaylistItem{
			{
				SceneID:    two.ID,
				Seconds:    5,
				Transition: "cut",
			}, {SceneID: one.ID, Seconds: 3600, Transition: "fade"}, {SceneID: two.ID, Seconds: 3, Transition: "cut"},
		}},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if reordered.Version != 2 || reordered.Name != "Morning loop" || len(reordered.Items) != 3 ||
		reordered.Items[0].SceneID != two.ID ||
		reordered.Items[1].SceneID != one.ID ||
		reordered.Items[2].Seconds != 3 {
		t.Fatalf("reordered = %#v", reordered)
	}
	if _, err := f.service.UpdatePlaylist(
		ctx,
		f.admin,
		playlist.ID,
		playlist.Version,
		signage.PlaylistInput{Name: "Stale"},
		nil,
	); !apperror.IsCode(
		err,
		"stale_write",
	) {
		t.Fatalf("stale update: %v", err)
	}

	// A failing replacement leaves name, version and items untouched.
	missing := ids.New()
	for name, items := range map[string][]signage.PlaylistItem{
		"missing scene": {
			{SceneID: three.ID, Seconds: 10, Transition: "cut"},
			{SceneID: missing, Seconds: 10, Transition: "cut"},
		},
		"seconds low":    {{SceneID: three.ID, Seconds: 2, Transition: "cut"}},
		"seconds high":   {{SceneID: three.ID, Seconds: 3601, Transition: "cut"}},
		"bad transition": {{SceneID: three.ID, Seconds: 10, Transition: "wipe"}},
		"too many":       make([]signage.PlaylistItem, 101),
	} {
		if name == "too many" {
			for index := range items {
				items[index] = signage.PlaylistItem{SceneID: three.ID, Seconds: 10, Transition: "cut"}
			}
		}
		if _, err := f.service.UpdatePlaylist(
			ctx,
			f.admin,
			playlist.ID,
			reordered.Version,
			signage.PlaylistInput{Name: "Broken", Items: items},
			nil,
		); !apperror.IsCode(
			err,
			"validation_failed",
		) {
			t.Errorf("%s: error = %v", name, err)
		}
	}
	unchanged, err := f.service.GetPlaylist(ctx, f.admin, playlist.ID)
	if err != nil || unchanged.Version != 2 || unchanged.Name != "Morning loop" || len(unchanged.Items) != 3 {
		t.Fatalf("failed replacement changed the playlist: %#v, %v", unchanged, err)
	}
	if _, err := f.service.CreatePlaylist(
		ctx,
		f.admin,
		signage.PlaylistInput{
			Name:  "Orphan",
			Items: []signage.PlaylistItem{{SceneID: missing, Seconds: 10, Transition: "cut"}},
		},
		nil,
	); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("create with missing scene: %v", err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM signage_playlists`, 1)

	list, err := f.service.ListPlaylists(ctx, f.admin)
	if err != nil || len(list) != 1 || len(list[0].Items) != 3 {
		t.Fatalf("list = %#v, %v", list, err)
	}

	// Deletion is blocked by displays (default playlist) and by rules.
	display := f.display(t, "Hall", playlist.ID)
	expectInUse(t, f.service.DeletePlaylist(ctx, f.admin, playlist.ID, unchanged.Version, nil), "display_default")
	other := f.playlist(t, "Other", three.ID)
	if _, err := f.pool.Exec(ctx, `INSERT INTO signage_rules (id, display_id, position, condition_kind, target_kind, target_playlist_id)
		VALUES (uuidv7(), $1, 0, 'live_data_unavailable', 'playlist', $2)`, display, other.ID); err != nil {
		t.Fatal(err)
	}
	expectInUse(t, f.service.DeletePlaylist(ctx, f.admin, other.ID, other.Version, nil), "display_rule")
	if err := f.service.DeletePlaylist(ctx, f.admin, other.ID, other.Version+1, nil); !apperror.IsCode(
		err,
		"stale_write",
	) {
		t.Fatalf("stale delete: %v", err)
	}
	if _, err := f.pool.Exec(ctx, `DELETE FROM signage_rules`); err != nil {
		t.Fatal(err)
	}
	if err := f.service.DeletePlaylist(ctx, f.admin, other.ID, other.Version, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM signage_playlist_items WHERE playlist_id=$1`, 0, other.ID)
	// A scene that sits in a playlist cannot be deleted.
	expectInUse(t, f.service.DeleteScene(ctx, f.admin, one.ID, one.Version, nil), "playlist")
}

func TestSignageTemplatesAndAnnouncementLifecycle(t *testing.T) {
	f := newSignageFixture(t)
	ctx := testContext(t)
	machine := f.machine(t, "Laser")
	playlist := f.playlist(t, "Default")
	display := f.display(t, "Entrance", playlist.ID)
	otherDisplay := f.display(t, "Workshop", playlist.ID)

	input := signage.TemplateInput{
		Name:  "Machine down",
		Tone:  "warning",
		Title: "{machine} out of order",
		Body:  "Back {back_on}. Room {room}. {display} at {location}. {ends}",
		Fields: []signage.TemplateField{
			{Key: "machine", Label: "Machine", Type: "machine", Required: true},
			{Key: "back_on", Label: "Back on", Type: "datetime"},
			{Key: "room", Label: "Room", Type: "choice", Options: []string{"Wood", "Metal"}, DefaultValue: "Wood"},
		},
	}
	template, err := f.service.CreateTemplate(ctx, f.admin, input, nil)
	if err != nil {
		t.Fatal(err)
	}
	if template.Version != 1 || len(template.Fields) != 3 || template.Fields[2].Options[1] != "Metal" {
		t.Fatalf("template = %#v", template)
	}
	for name, change := range map[string]func(*signage.TemplateInput){
		"unknown placeholder": func(i *signage.TemplateInput) { i.Body = "{nobody}" },
		"built-in key":        func(i *signage.TemplateInput) { i.Fields[0].Key = "display" },
	} {
		candidate := input
		candidate.Fields = append([]signage.TemplateField(nil), input.Fields...)
		change(&candidate)
		_, err := f.service.CreateTemplate(ctx, f.admin, candidate, nil)
		if name == "unknown placeholder" {
			expectAppCode(t, err, "unknown_placeholders")
		} else {
			expectAppCode(t, err, "validation_failed")
		}
	}
	// Editing: stale version, unknown placeholder, success.
	edited := input
	edited.Name = "Machine out of order"
	if _, err := f.service.UpdateTemplate(ctx, f.admin, template.ID, 7, edited, nil); !apperror.IsCode(
		err,
		"stale_write",
	) {
		t.Fatalf("stale template update: %v", err)
	}
	broken := edited
	broken.Title = "{unknown_thing}"
	if _, err := f.service.UpdateTemplate(ctx, f.admin, template.ID, template.Version, broken, nil); !apperror.IsCode(
		err,
		"unknown_placeholders",
	) {
		t.Fatalf("unknown placeholder on update: %v", err)
	}
	template, err = f.service.UpdateTemplate(ctx, f.admin, template.ID, template.Version, edited, nil)
	if err != nil || template.Version != 2 || template.Name != "Machine out of order" {
		t.Fatalf("template update = %#v, %v", template, err)
	}

	// Starting: validation per type and required.
	start := signage.AnnouncementInput{
		TemplateID:  template.ID,
		Values:      map[string]string{"machine": machine.String(), "back_on": "2026-10-23T09:00"},
		AllDisplays: true,
	}
	cases := map[string]func(*signage.AnnouncementInput){
		"required missing":  func(i *signage.AnnouncementInput) { i.Values = map[string]string{"back_on": "2026-10-23T09:00"} },
		"unknown key":       func(i *signage.AnnouncementInput) { i.Values["colour"] = "red" },
		"bad datetime":      func(i *signage.AnnouncementInput) { i.Values["back_on"] = "tomorrow" },
		"bad choice":        func(i *signage.AnnouncementInput) { i.Values["room"] = "Attic" },
		"machine not an id": func(i *signage.AnnouncementInput) { i.Values["machine"] = "laser" },
		"machine missing":   func(i *signage.AnnouncementInput) { i.Values["machine"] = ids.New().String() },
		"all and selected":  func(i *signage.AnnouncementInput) { i.DisplayIDs = []uuid.UUID{display} },
		"no target":         func(i *signage.AnnouncementInput) { i.AllDisplays = false },
		"display missing": func(i *signage.AnnouncementInput) {
			i.AllDisplays = false
			i.DisplayIDs = []uuid.UUID{ids.New()}
		},
		"template missing": func(i *signage.AnnouncementInput) { i.TemplateID = ids.New() },
		"end in the past":  func(i *signage.AnnouncementInput) { past := time.Now().Add(-time.Hour); i.EndsAt = &past },
		"end before start": func(i *signage.AnnouncementInput) {
			later := time.Now().Add(2 * time.Hour)
			end := time.Now().Add(time.Hour)
			i.StartsAt, i.EndsAt = &later, &end
		},
	}
	for name, change := range cases {
		candidate := start
		candidate.Values = map[string]string{"machine": machine.String(), "back_on": "2026-10-23T09:00"}
		change(&candidate)
		if _, err := f.service.StartAnnouncement(ctx, f.admin, candidate, nil); !apperror.IsCode(
			err,
			"validation_failed",
		) {
			t.Errorf("%s: error = %v, want validation_failed", name, err)
		}
	}
	assertCount(t, f.pool, `SELECT count(*) FROM signage_announcements`, 0)

	// A running announcement for all displays; defaults fill missing optional values.
	running, err := f.service.StartAnnouncement(ctx, f.admin, start, nil)
	if err != nil {
		t.Fatal(err)
	}
	if running.Status != "active" || !running.AllDisplays || len(running.DisplayIDs) != 0 || running.EndsAt != nil ||
		running.Values["room"] != "Wood" ||
		running.Version != 1 {
		t.Fatalf("running = %#v", running)
	}
	if running.Rendered.Title != "Laser out of order" || running.Rendered.Tone != "warning" ||
		!strings.Contains(
			running.Rendered.Body,
			"Room Wood.",
		) || !strings.Contains(running.Rendered.Body, "{display} at {location}") || !strings.Contains(running.Rendered.Body, "until further notice") {
		t.Fatalf("rendered = %#v", running.Rendered)
	}

	// Scheduled announcement for selected displays.
	startsAt, endsAt := time.Now().Add(time.Hour), time.Now().Add(3*time.Hour)
	scheduled, err := f.service.StartAnnouncement(ctx, f.admin, signage.AnnouncementInput{
		TemplateID: template.ID, Values: map[string]string{"machine": machine.String()}, DisplayIDs: []uuid.UUID{
			otherDisplay,
			display,
			display,
		}, StartsAt: &startsAt, EndsAt: &endsAt,
	}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if scheduled.Status != "scheduled" || scheduled.AllDisplays || len(scheduled.DisplayIDs) != 2 ||
		scheduled.EndsAt == nil ||
		strings.Contains(scheduled.Rendered.Body, "until further notice") {
		t.Fatalf("scheduled = %#v", scheduled)
	}

	// Ended announcements are hidden, and removed 30 days after they ended.
	ended, recent := ids.New(), ids.New()
	for id, endedAgo := range map[uuid.UUID]string{ended: "31 days", recent: "2 hours"} {
		if _, err := f.pool.Exec(
			ctx,
			`INSERT INTO signage_announcements (id, template_id, all_displays, starts_at, ends_at) VALUES ($1, $2, true, now() - interval '40 days', now() - $3::interval)`,
			id,
			template.ID,
			endedAgo,
		); err != nil {
			t.Fatal(err)
		}
		if _, err := f.pool.Exec(
			ctx,
			`INSERT INTO signage_announcement_values (announcement_id, key, value) VALUES ($1, 'machine', $2)`,
			id,
			machine.String(),
		); err != nil {
			t.Fatal(err)
		}
	}
	listed, err := f.service.ListAnnouncements(ctx, f.admin)
	if err != nil {
		t.Fatal(err)
	}
	if len(listed) != 2 || listed[0].ID != running.ID || listed[1].ID != scheduled.ID {
		t.Fatalf("listed = %#v", listed)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM signage_announcements WHERE id=$1`, 0, ended)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_announcement_values WHERE announcement_id=$1`, 0, ended)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_announcements WHERE id=$1`, 1, recent)
	assertCount(
		t,
		f.pool,
		`SELECT count(*) FROM audit_events WHERE action='signage_announcement.expired' AND resource_id=$1 AND actor_type='system'`,
		1,
		ended,
	)
	if _, err := f.service.GetAnnouncement(ctx, f.admin, recent); !apperror.IsCode(err, "not_found") {
		t.Fatalf("ended announcement visible: %v", err)
	}
	if _, err := f.service.UpdateAnnouncement(
		ctx,
		f.admin,
		recent,
		1,
		signage.AnnouncementInput{
			Values:      map[string]string{"machine": machine.String()},
			AllDisplays: true,
			StartsAt:    &startsAt,
		},
		nil,
	); !apperror.IsCode(
		err,
		"not_found",
	) {
		t.Fatalf("ended announcement editable: %v", err)
	}

	// Editing: stale write, changed targets and values.
	newEnd := time.Now().Add(5 * time.Hour)
	edit := signage.AnnouncementInput{
		Values:     map[string]string{"machine": machine.String(), "room": "Metal"},
		DisplayIDs: []uuid.UUID{display},
		StartsAt:   &startsAt,
		EndsAt:     &newEnd,
	}
	if _, err := f.service.UpdateAnnouncement(ctx, f.admin, scheduled.ID, 9, edit, nil); !apperror.IsCode(
		err,
		"stale_write",
	) {
		t.Fatalf("stale announcement edit: %v", err)
	}
	if _, err := f.service.UpdateAnnouncement(
		ctx,
		f.admin,
		scheduled.ID,
		scheduled.Version,
		signage.AnnouncementInput{Values: map[string]string{"machine": machine.String()}, AllDisplays: true},
		nil,
	); !apperror.IsCode(
		err,
		"validation_failed",
	) {
		t.Fatalf("edit without startsAt: %v", err)
	}
	editedAnnouncement, err := f.service.UpdateAnnouncement(ctx, f.admin, scheduled.ID, scheduled.Version, edit, nil)
	if err != nil {
		t.Fatal(err)
	}
	if editedAnnouncement.Version != 2 || len(editedAnnouncement.DisplayIDs) != 1 ||
		editedAnnouncement.DisplayIDs[0] != display ||
		editedAnnouncement.Values["room"] != "Metal" {
		t.Fatalf("edited = %#v", editedAnnouncement)
	}
	assertCount(
		t,
		f.pool,
		`SELECT count(*) FROM signage_announcement_displays WHERE announcement_id=$1`,
		1,
		scheduled.ID,
	)

	// Deleting a template is blocked while announcements run, a rule filters it or a widget uses it.
	expectInUse(
		t,
		f.service.DeleteTemplate(ctx, f.admin, template.ID, template.Version, nil),
		"announcement",
		"announcement",
	)
	// Stopping hard-deletes the announcement with its values and targets.
	if err := f.service.StopAnnouncement(ctx, f.admin, scheduled.ID, 1, nil); !apperror.IsCode(err, "stale_write") {
		t.Fatalf("stale stop: %v", err)
	}
	if err := f.service.StopAnnouncement(ctx, f.admin, scheduled.ID, editedAnnouncement.Version, nil); err != nil {
		t.Fatal(err)
	}
	if err := f.service.StopAnnouncement(ctx, f.admin, running.ID, running.Version, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(
		t,
		f.pool,
		`SELECT count(*) FROM signage_announcement_values WHERE announcement_id IN ($1, $2)`,
		0,
		scheduled.ID,
		running.ID,
	)
	assertCount(
		t,
		f.pool,
		`SELECT count(*) FROM signage_announcement_displays WHERE announcement_id=$1`,
		0,
		scheduled.ID,
	)
	if err := f.service.StopAnnouncement(ctx, f.admin, running.ID, running.Version, nil); !apperror.IsCode(
		err,
		"not_found",
	) {
		t.Fatalf("second stop: %v", err)
	}

	// A rule filtering this template also blocks deletion.
	scene := f.scene(t, "Rule scene")
	if _, err := f.pool.Exec(ctx, `INSERT INTO signage_rules (id, display_id, position, condition_kind, announcement_template_ids, target_kind, target_scene_id)
		VALUES (uuidv7(), $1, 0, 'announcement_active', ARRAY[$2]::uuid[], 'scene', $3)`, display, template.ID, scene.ID); err != nil {
		t.Fatal(err)
	}
	expectInUse(t, f.service.DeleteTemplate(ctx, f.admin, template.ID, template.Version, nil), "display_rule")
	if _, err := f.pool.Exec(ctx, `DELETE FROM signage_rules`); err != nil {
		t.Fatal(err)
	}
	// Only the already ended announcement is left: it is deleted together with the template.
	if err := f.service.DeleteTemplate(ctx, f.admin, template.ID, template.Version, nil); err != nil {
		t.Fatal(err)
	}
	assertCount(t, f.pool, `SELECT count(*) FROM signage_announcements`, 0)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_announcement_template_fields`, 0)
}

func TestSignageTemplateUpdateDropsValuesOfRemovedFields(t *testing.T) {
	f := newSignageFixture(t)
	ctx := testContext(t)
	template, err := f.service.CreateTemplate(
		ctx,
		f.admin,
		signage.TemplateInput{Name: "Notice", Tone: "info", Title: "{a}", Body: "{b}", Fields: []signage.TemplateField{
			{Key: "a", Label: "A", Type: "text"}, {Key: "b", Label: "B", Type: "text"},
		}},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	announcement, err := f.service.StartAnnouncement(
		ctx,
		f.admin,
		signage.AnnouncementInput{
			TemplateID:  template.ID,
			Values:      map[string]string{"a": "one", "b": "two"},
			AllDisplays: true,
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.UpdateTemplate(
		ctx,
		f.admin,
		template.ID,
		template.Version,
		signage.TemplateInput{
			Name:   "Notice",
			Tone:   "info",
			Title:  "{a}",
			Body:   "",
			Fields: []signage.TemplateField{{Key: "a", Label: "A", Type: "text"}},
		},
		nil,
	); err != nil {
		t.Fatal(err)
	}
	assertCount(
		t,
		f.pool,
		`SELECT count(*) FROM signage_announcement_values WHERE announcement_id=$1`,
		1,
		announcement.ID,
	)
	read, err := f.service.GetAnnouncement(ctx, f.admin, announcement.ID)
	if err != nil || read.Values["a"] != "one" || read.Values["b"] != "" || read.Rendered.Title != "one" {
		t.Fatalf("announcement after template edit = %#v, %v", read, err)
	}
}

// TestSignageMutationsAndAuditShareOneTransaction makes the audit insert fail and checks that nothing else was kept.
func TestSignageMutationsAndAuditShareOneTransaction(t *testing.T) {
	f := newSignageFixture(t)
	ctx := testContext(t)
	if _, err := f.pool.Exec(
		ctx,
		`CREATE FUNCTION reject_signage_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'signage_%' THEN RAISE EXCEPTION 'forced signage audit failure'; END IF; RETURN NEW; END; $$`,
	); err != nil {
		t.Fatal(err)
	}
	scene := f.scene(t, "Existing")
	template, err := f.service.CreateTemplate(
		ctx,
		f.admin,
		signage.TemplateInput{
			Name:   "T",
			Tone:   "info",
			Title:  "Hi",
			Body:   "",
			Fields: []signage.TemplateField{{Key: "who", Label: "Who", Type: "text"}},
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	playlist := f.playlist(t, "P", scene.ID)
	announcement, err := f.service.StartAnnouncement(
		ctx,
		f.admin,
		signage.AnnouncementInput{TemplateID: template.ID, Values: map[string]string{"who": "kept"}, AllDisplays: true},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	asset := f.uploadImage(t, "kept.jpg")
	if _, err := f.pool.Exec(
		ctx,
		`CREATE TRIGGER reject_signage_audit_insert BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION reject_signage_audit()`,
	); err != nil {
		t.Fatal(err)
	}
	startsAt := time.Now()

	if _, err := f.service.CreateScene(ctx, f.admin, sceneInput("Never", "full"), nil); err == nil {
		t.Fatal("scene committed without audit")
	}
	if _, err := f.service.UpdateScene(
		ctx,
		f.admin,
		scene.ID,
		scene.Version,
		sceneInput("Renamed", "full"),
		nil,
	); err == nil {
		t.Fatal("scene update committed without audit")
	}
	if err := f.service.DeleteScene(ctx, f.admin, scene.ID, scene.Version, nil); err == nil {
		t.Fatal("scene delete committed without audit")
	}
	if _, err := f.service.CreatePlaylist(
		ctx,
		f.admin,
		signage.PlaylistInput{
			Name:  "Never",
			Items: []signage.PlaylistItem{{SceneID: scene.ID, Seconds: 10, Transition: "cut"}},
		},
		nil,
	); err == nil {
		t.Fatal("playlist committed without audit")
	}
	if _, err := f.service.UpdatePlaylist(
		ctx,
		f.admin,
		playlist.ID,
		playlist.Version,
		signage.PlaylistInput{Name: "Renamed"},
		nil,
	); err == nil {
		t.Fatal("playlist update committed without audit")
	}
	if _, err := f.service.CreateTemplate(
		ctx,
		f.admin,
		signage.TemplateInput{Name: "Never", Tone: "info", Title: "T"},
		nil,
	); err == nil {
		t.Fatal("template committed without audit")
	}
	if _, err := f.service.UpdateTemplate(
		ctx,
		f.admin,
		template.ID,
		template.Version,
		signage.TemplateInput{Name: "Renamed", Tone: "info", Title: "T"},
		nil,
	); err == nil {
		t.Fatal("template update committed without audit")
	}
	if _, err := f.service.StartAnnouncement(
		ctx,
		f.admin,
		signage.AnnouncementInput{TemplateID: template.ID, Values: map[string]string{"who": "lost"}, AllDisplays: true},
		nil,
	); err == nil {
		t.Fatal("announcement committed without audit")
	}
	if _, err := f.service.UpdateAnnouncement(
		ctx,
		f.admin,
		announcement.ID,
		announcement.Version,
		signage.AnnouncementInput{Values: map[string]string{"who": "changed"}, AllDisplays: true, StartsAt: &startsAt},
		nil,
	); err == nil {
		t.Fatal("announcement update committed without audit")
	}
	if err := f.service.StopAnnouncement(ctx, f.admin, announcement.ID, announcement.Version, nil); err == nil {
		t.Fatal("announcement stop committed without audit")
	}
	if _, err := f.service.RenameAsset(ctx, f.admin, asset.ID, "renamed.jpg", nil); err == nil {
		t.Fatal("asset rename committed without audit")
	}
	if err := f.service.DeleteAsset(ctx, f.admin, asset.ID, nil); err == nil {
		t.Fatal("asset delete committed without audit")
	}
	if _, err := f.service.UploadAsset(
		ctx,
		f.admin,
		signage.UploadInput{Name: "never.jpg", ContentType: "image/jpeg", Body: bytes.NewReader(signageJPEG(t, 8, 8))},
		nil,
	); err == nil {
		t.Fatal("asset upload committed without audit")
	}

	assertCount(t, f.pool, `SELECT count(*) FROM signage_scenes WHERE name='Existing'`, 1)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_scenes`, 1)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_playlists WHERE name='P'`, 1)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_playlists`, 1)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_playlist_items WHERE playlist_id=$1`, 1, playlist.ID)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_announcement_templates WHERE name='T' AND version=1`, 1)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_announcement_templates`, 1)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_announcements WHERE version=1`, 1)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_announcements`, 1)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_announcement_values WHERE value='kept'`, 1)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_assets WHERE name='kept.jpg'`, 1)
	assertCount(t, f.pool, `SELECT count(*) FROM signage_assets`, 1)
	// The failed upload also removed its stored bytes again.
	assertCount(t, f.pool, `SELECT count(*) FROM files`, 1)
}

func TestSignageAnnouncementAuditContainsFieldNamesOnly(t *testing.T) {
	f := newSignageFixture(t)
	ctx := testContext(t)
	template, err := f.service.CreateTemplate(
		ctx,
		f.admin,
		signage.TemplateInput{
			Name:   "Notice",
			Tone:   "info",
			Title:  "{who}",
			Fields: []signage.TemplateField{{Key: "who", Label: "Who", Type: "text"}},
		},
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := f.service.StartAnnouncement(
		ctx,
		f.admin,
		signage.AnnouncementInput{
			TemplateID:  template.ID,
			Values:      map[string]string{"who": "SECRET-MESSAGE-TEXT"},
			AllDisplays: true,
		},
		nil,
	); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := f.pool.QueryRow(
		ctx,
		`SELECT count(*) FROM audit_events WHERE (changed_fields::text || metadata::text) LIKE '%SECRET-MESSAGE-TEXT%'`,
	).Scan(&count); err != nil ||
		count != 0 {
		t.Fatalf("announcement value reached the audit log (%d, %v)", count, err)
	}
	assertCount(
		t,
		f.pool,
		`SELECT count(*) FROM audit_events WHERE action='signage_announcement.started' AND actor_type='user'`,
		1,
	)
}

func TestSignageHTTPContractUploadDownloadScenesAndPermissions(t *testing.T) {
	pool := migratedPool(t)
	ctx := testContext(t)
	cfg := integrationConfig(t)
	cfg.LocalStorageRoot = t.TempDir()
	cfg.SessionCookieName = "makerspace_session"
	cfg.CSRFCookieName = "makerspace_csrf"
	_, editor := signageActor(
		t,
		pool,
		"http-editor",
		authorization.SignageRead,
		authorization.SignageContentManage,
		authorization.SignageOverride,
	)
	_, viewer := signageActor(t, pool, "http-viewer", authorization.SignageRead)
	_, outsider := signageActor(t, pool, "http-outsider", authorization.SignageContentManage)
	handler, err := httpapi.NewHandler(pool, cfg, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(handler)
	defer server.Close()
	login := func(account seededAccount) (*http.Client, string) {
		session, csrf := insertTestSession(t, pool, account)
		return clientWithSession(t, server.URL, session, csrf), csrf
	}
	editorClient, editorCSRF := login(editor)
	viewerClient, viewerCSRF := login(viewer)
	outsiderClient, outsiderCSRF := login(outsider)
	origin := cfg.PublicBaseURL.String()
	api := server.URL + "/api/v1"
	send := func(client *http.Client, csrf, method, path string, body any, headers map[string]string) *http.Response {
		var reader io.Reader
		if raw, ok := body.([]byte); ok {
			reader = bytes.NewReader(raw)
		} else if body != nil {
			encoded, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			reader = bytes.NewReader(encoded)
		}
		request, err := http.NewRequestWithContext(ctx, method, api+path, reader)
		if err != nil {
			t.Fatal(err)
		}
		if _, raw := body.([]byte); raw {
			request.Header.Set("Content-Type", "application/octet-stream")
		} else if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		request.Header.Set("Origin", origin)
		request.Header.Set("X-CSRF-Token", csrf)
		for key, value := range headers {
			request.Header.Set(key, value)
		}
		response, err := client.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		return response
	}
	decode := func(response *http.Response) map[string]any {
		t.Helper()
		defer response.Body.Close()
		var value map[string]any
		if err := json.NewDecoder(response.Body).Decode(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}

	// Layouts.
	response := send(viewerClient, viewerCSRF, http.MethodGet, "/signage/layouts", nil, nil)
	assertStatus(t, response, http.StatusOK)
	layouts := decode(response)["items"].([]any)
	if len(layouts) != 9 {
		t.Fatalf("layouts = %d", len(layouts))
	}
	response = send(outsiderClient, outsiderCSRF, http.MethodGet, "/signage/layouts", nil, nil)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()

	// Upload: read-only callers are refused, content managers succeed.
	imageBytes := signageJPEG(t, 40, 30)
	uploadHeaders := map[string]string{"X-File-Name": "poster.jpg", "X-File-Content-Type": "image/jpeg"}
	response = send(viewerClient, viewerCSRF, http.MethodPost, "/signage/assets", imageBytes, uploadHeaders)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	response = send(
		editorClient,
		editorCSRF,
		http.MethodPost,
		"/signage/assets",
		imageBytes,
		map[string]string{"X-File-Name": "poster.jpg", "X-File-Content-Type": "application/pdf"},
	)
	assertStatus(t, response, http.StatusBadRequest)
	response.Body.Close()
	response = send(editorClient, editorCSRF, http.MethodPost, "/signage/assets", imageBytes, uploadHeaders)
	assertStatus(t, response, http.StatusCreated)
	asset := decode(response)
	assetID := asset["id"].(string)
	if asset["kind"] != "image" || asset["width"] != float64(40) || asset["height"] != float64(30) ||
		asset["durationMs"] != nil {
		t.Fatalf("asset = %#v", asset)
	}
	response = send(
		editorClient,
		editorCSRF,
		http.MethodPost,
		"/signage/assets",
		signageMP4(2<<20),
		map[string]string{
			"X-File-Name":         "clip.mp4",
			"X-File-Content-Type": "video/mp4",
			"X-Asset-Width":       "1280",
			"X-Asset-Height":      "720",
			"X-Asset-Duration-Ms": "5000",
		},
	)
	assertStatus(t, response, http.StatusCreated)
	if clip := decode(response); clip["kind"] != "video" || clip["width"] != float64(1280) ||
		clip["durationMs"] != float64(5000) {
		t.Fatalf("clip = %#v", clip)
	}

	// Download is private, uncached and sandboxed; outsiders without read cannot fetch it.
	response = send(viewerClient, viewerCSRF, http.MethodGet, "/signage/assets/"+assetID+"/content", nil, nil)
	assertStatus(t, response, http.StatusOK)
	served := readResponse(t, response)
	if !bytes.Equal(served, imageBytes) || response.Header.Get("Content-Type") != "image/jpeg" ||
		response.Header.Get("X-Content-Type-Options") != "nosniff" ||
		!strings.Contains(response.Header.Get("Cache-Control"), "no-store") ||
		!strings.Contains(response.Header.Get("Cache-Control"), "private") ||
		!strings.Contains(response.Header.Get("Content-Security-Policy"), "sandbox") {
		t.Fatalf("download headers/bytes wrong: %v", response.Header)
	}
	response = send(outsiderClient, outsiderCSRF, http.MethodGet, "/signage/assets/"+assetID+"/content", nil, nil)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()

	// Scenes through the union-typed zones schema.
	scene := map[string]any{
		"name":            "Welcome",
		"orientation":     "landscape",
		"layoutId":        "split",
		"backgroundColor": "#102030",
		"backgroundFit":   "cover",
		"backgroundDim":   10,
		"theme":           "dark",
		"zones": map[string]any{
			"left":  map[string]any{"type": "image", "mediaId": assetID, "fit": "cover"},
			"right": map[string]any{"type": "qr", "url": "https://makerspace.example/join", "caption": "Join"},
		},
	}
	response = send(viewerClient, viewerCSRF, http.MethodPost, "/signage/scenes", scene, nil)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	response = send(editorClient, editorCSRF, http.MethodPost, "/signage/scenes", scene, nil)
	assertStatus(t, response, http.StatusCreated)
	created := decode(response)
	sceneID := created["id"].(string)
	zones := created["zones"].(map[string]any)
	if created["version"] != float64(1) || zones["left"].(map[string]any)["mediaId"] != assetID ||
		zones["right"].(map[string]any)["url"] != "https://makerspace.example/join" {
		t.Fatalf("created scene = %#v", created)
	}
	bad := map[string]any{}
	for key, value := range scene {
		bad[key] = value
	}
	bad["zones"] = map[string]any{"left": map[string]any{"type": "clock", "mode": "time", "html": "<b>"}}
	response = send(editorClient, editorCSRF, http.MethodPost, "/signage/scenes", bad, nil)
	if response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("unknown widget field status = %d", response.StatusCode)
	}
	response.Body.Close()
	bad["zones"] = map[string]any{"left": map[string]any{"type": "qr", "url": "http://plain.example", "caption": ""}}
	response = send(editorClient, editorCSRF, http.MethodPost, "/signage/scenes", bad, nil)
	if response.StatusCode != http.StatusBadRequest && response.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("http QR status = %d", response.StatusCode)
	}
	response.Body.Close()

	// Update without zones changes the layout and remaps by position; stale versions conflict.
	update := map[string]any{
		"expectedVersion": 1,
		"name":            "Welcome",
		"orientation":     "landscape",
		"layoutId":        "stack3",
		"backgroundColor": "#102030",
		"backgroundFit":   "cover",
		"backgroundDim":   10,
		"theme":           "dark",
	}
	response = send(editorClient, editorCSRF, http.MethodPut, "/signage/scenes/"+sceneID, update, nil)
	assertStatus(t, response, http.StatusOK)
	moved := decode(response)["zones"].(map[string]any)
	if moved["header"].(map[string]any)["type"] != "image" || moved["main"].(map[string]any)["type"] != "qr" ||
		moved["footer"].(map[string]any)["type"] != "empty" {
		t.Fatalf("remapped zones = %#v", moved)
	}
	response = send(editorClient, editorCSRF, http.MethodPut, "/signage/scenes/"+sceneID, update, nil)
	assertStatus(t, response, http.StatusConflict)
	if conflict := decode(response); conflict["code"] != "stale_write" {
		t.Fatalf("stale write body = %#v", conflict)
	}

	// Deleting a referenced asset is a 409 listing the scene.
	response = send(editorClient, editorCSRF, http.MethodDelete, "/signage/assets/"+assetID, nil, nil)
	assertStatus(t, response, http.StatusConflict)
	conflict := decode(response)
	details, _ := conflict["details"].(map[string]any)
	references, _ := details["references"].([]any)
	if conflict["code"] != "signage_in_use" || len(references) != 1 ||
		references[0].(map[string]any)["id"] != sceneID ||
		references[0].(map[string]any)["kind"] != "scene" {
		t.Fatalf("in-use body = %#v", conflict)
	}
	response = send(outsiderClient, outsiderCSRF, http.MethodGet, "/signage/scenes", nil, nil)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()

	// Playlist, template and announcement round trip over HTTP.
	response = send(
		editorClient,
		editorCSRF,
		http.MethodPost,
		"/signage/playlists",
		map[string]any{
			"name":  "Loop",
			"items": []any{map[string]any{"sceneId": sceneID, "seconds": 12, "transition": "fade"}},
		},
		nil,
	)
	assertStatus(t, response, http.StatusCreated)
	if playlist := decode(response); len(playlist["items"].([]any)) != 1 {
		t.Fatalf("playlist = %#v", playlist)
	}
	response = send(editorClient, editorCSRF, http.MethodPost, "/signage/announcement-templates", map[string]any{
		"name": "Closed", "tone": "warning", "title": "Closed until {back_on}", "body": "{ends}",
		"fields": []any{
			map[string]any{
				"key":          "back_on",
				"label":        "Back on",
				"type":         "time",
				"required":     true,
				"defaultValue": "",
				"helperText":   "",
				"options":      []any{},
			},
		},
	}, nil)
	assertStatus(t, response, http.StatusCreated)
	templateID := decode(response)["id"].(string)
	response = send(
		editorClient,
		editorCSRF,
		http.MethodPost,
		"/signage/announcements",
		map[string]any{
			"templateId":  templateID,
			"values":      map[string]any{"back_on": "14:30"},
			"allDisplays": true,
			"displayIds":  []any{},
		},
		nil,
	)
	assertStatus(t, response, http.StatusCreated)
	announcement := decode(response)
	rendered := announcement["rendered"].(map[string]any)
	if announcement["status"] != "active" || rendered["title"] != "Closed until 14:30" ||
		rendered["body"] != "until further notice" ||
		announcement["endsAt"] != nil {
		t.Fatalf("announcement = %#v", announcement)
	}
	response = send(
		viewerClient,
		viewerCSRF,
		http.MethodPost,
		"/signage/announcements",
		map[string]any{
			"templateId":  templateID,
			"values":      map[string]any{"back_on": "14:30"},
			"allDisplays": true,
			"displayIds":  []any{},
		},
		nil,
	)
	assertStatus(t, response, http.StatusForbidden)
	response.Body.Close()
	response = send(viewerClient, viewerCSRF, http.MethodGet, "/signage/announcements", nil, nil)
	assertStatus(t, response, http.StatusOK)
	if items := decode(response)["items"].([]any); len(items) != 1 {
		t.Fatalf("announcement list = %#v", items)
	}
	response = send(
		editorClient,
		editorCSRF,
		http.MethodDelete,
		"/signage/announcements/"+announcement["id"].(string),
		map[string]any{"expectedVersion": 1},
		nil,
	)
	assertStatus(t, response, http.StatusNoContent)
	response.Body.Close()
	response = send(
		editorClient,
		editorCSRF,
		http.MethodGet,
		"/signage/announcements/"+announcement["id"].(string),
		nil,
		nil,
	)
	assertStatus(t, response, http.StatusNotFound)
	response.Body.Close()
}

var _ = context.Background
