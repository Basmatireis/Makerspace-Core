package signage

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
)

// AnnouncementImage is the effective background image of a rendered announcement. The url is formed by the
// transport layer for the caller (staff, player or web embed).
type AnnouncementImage struct {
	AssetID uuid.UUID
	SHA256  string
}

// checkColor normalises an optional announcement colour and requires that white or #161616 text can be read on it.
// Nil stays nil: the tone colour.
func checkColor(color *string) (*string, error) {
	if color == nil {
		return nil, nil
	}
	normalized, ok := NormalizeColor(*color)
	if !ok {
		return nil, validation("color must be a colour as #rrggbb")
	}
	if _, readable := AnnouncementTextColor(normalized); !readable {
		result := apperror.New(
			422,
			"signage_color_contrast",
			"Neither white nor dark text is readable on this colour; choose a lighter or darker one",
		)
		result.Details["field"] = "color"
		return nil, result
	}
	return &normalized, nil
}

// verifyImage checks that an optional image asset exists and is an image. The asset is share-locked so that a
// concurrent deletion either waits for this transaction or finds the new reference.
func verifyImage(ctx context.Context, q *signagedb.Queries, id *uuid.UUID) error {
	if id == nil {
		return nil
	}
	rows, err := q.ListSignageAssetKinds(ctx, uuidStrings([]uuid.UUID{*id}))
	if err != nil {
		return err
	}
	if len(rows) != 1 || AssetKind(rows[0].Kind) != AssetKindImage {
		return validation("image asset %s does not exist", *id)
	}
	return nil
}

// textColorOf derives the text colour of an effective colour; null exactly when the colour is null.
func textColorOf(color *string) *string {
	if color == nil {
		return nil
	}
	text, _ := AnnouncementTextColor(*color)
	return &text
}

// effectiveLook is the effective colour and image of an announcement: its own while ownLook is set, else its template's.
func effectiveLook(
	template signagedb.SignageAnnouncementTemplate,
	row signagedb.SignageAnnouncement,
) (color *string, image *uuid.UUID) {
	if row.OwnLook {
		return row.Color, row.ImageAssetID
	}
	return template.Color, template.ImageAssetID
}

// lookOf resolves the effective colour and image of a rendered announcement; digests maps image asset ids to their
// checksums. An image whose asset is gone (deleted while the row is read) is left out.
func lookOf(
	template signagedb.SignageAnnouncementTemplate,
	row signagedb.SignageAnnouncement,
	digests map[uuid.UUID]string,
) (*string, *AnnouncementImage) {
	color, image := effectiveLook(template, row)
	if image == nil {
		return color, nil
	}
	digest, ok := digests[*image]
	if !ok {
		return color, nil
	}
	return color, &AnnouncementImage{AssetID: *image, SHA256: digest}
}

// checkLook validates the look of an announcement input and returns its normalised colour. Without ownLook the
// template's look applies and no own values may be given.
func (s *Service) checkLook(ctx context.Context, q *signagedb.Queries, input AnnouncementInput) (*string, error) {
	if !input.OwnLook {
		if input.Color != nil || input.ImageAssetID != nil {
			return nil, validation("color and imageAssetId need ownLook")
		}
		return nil, nil
	}
	color, err := checkColor(input.Color)
	if err != nil {
		return nil, err
	}
	return color, verifyImage(ctx, q, input.ImageAssetID)
}
