package machinelogbook

import (
	"context"
	"errors"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/audit"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	machinelogbookdb "github.com/Basmatireis/Makerspace-Core/backend/internal/machinelogbook/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/apperror"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/database"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/platform/ids"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func validateVariantName(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > maxVariantLength {
		return "", apperror.Invalid("name is required and limited to 80 characters")
	}
	return name, nil
}

func variantConflict(err error) error {
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "23505" && pgErr.ConstraintName == "material_type_variants_name_ci_idx" {
		return apperror.Conflicting("material_type_variant_exists", "The material type already has a variant with this name")
	}
	return databaseError(err)
}

var errVariantNotAllowed = unprocessable("material_type_variant_not_allowed", "Parts take no variants")

// materialTypeVariants loads the variants of the given types, by name.
func materialTypeVariants(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	typeIDs []uuid.UUID,
) (map[uuid.UUID][]MaterialTypeVariant, error) {
	rows, err := q.ListMaterialTypeVariants(ctx, uuidStrings(typeIDs))
	if err != nil {
		return nil, err
	}
	byType := map[uuid.UUID][]MaterialTypeVariant{}
	for _, row := range rows {
		byType[row.MaterialTypeID] = append(byType[row.MaterialTypeID], MaterialTypeVariant{
			ID:               row.ID,
			MaterialTypeID:   row.MaterialTypeID,
			Name:             row.Name,
			MaterialCount:    row.MaterialCount,
			PricingRuleCount: row.PricingRuleCount,
		})
	}
	return byType, nil
}

// loadMaterialTypeVariant reads one variant with its counts.
func loadMaterialTypeVariant(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	typeID, id uuid.UUID,
) (MaterialTypeVariant, error) {
	variants, err := materialTypeVariants(ctx, q, []uuid.UUID{typeID})
	if err != nil {
		return MaterialTypeVariant{}, err
	}
	for _, variant := range variants[typeID] {
		if variant.ID == id {
			return variant, nil
		}
	}
	return MaterialTypeVariant{}, apperror.NotFound
}

// lockVariantType share-locks the type a variant request names; a missing type is not found.
func lockVariantType(
	ctx context.Context,
	q *machinelogbookdb.Queries,
	typeID uuid.UUID,
) (machinelogbookdb.MaterialType, error) {
	row, err := q.GetMaterialTypeForShare(ctx, typeID)
	return row, noRows(err)
}

func writeVariantAudit(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	action string,
	typeID, variantID uuid.UUID,
	requestID *uuid.UUID,
	fields []string,
) error {
	return audit.Write(ctx, tx, audit.Event{
		ActorAccountID: accountPointer(p),
		Action:         action,
		ResourceType:   "material_type",
		ResourceID:     &typeID,
		RequestID:      requestID,
		ChangedFields:  fields,
		Metadata:       map[string]any{"variantId": variantID.String()},
	})
}

// insertVariant adds a variant to a share-locked type and audits it.
func insertVariant(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	materialType machinelogbookdb.MaterialType,
	name string,
	requestID *uuid.UUID,
) (machinelogbookdb.MaterialTypeVariant, error) {
	if MaterialKind(materialType.Kind) == KindPart {
		return machinelogbookdb.MaterialTypeVariant{}, errVariantNotAllowed
	}
	row, err := machinelogbookdb.New(tx).CreateMaterialTypeVariant(
		ctx,
		machinelogbookdb.CreateMaterialTypeVariantParams{ID: ids.New(), MaterialTypeID: materialType.ID, Name: name},
	)
	if err != nil {
		return row, variantConflict(err)
	}
	if err = writeVariantAudit(
		ctx, tx, p, "material_type.variant_created", materialType.ID, row.ID, requestID, []string{"variants"},
	); err != nil {
		return row, err
	}
	return row, nil
}

// CreateMaterialTypeVariant adds a variant to a type. Names are unique per type ignoring case; parts take none.
func (s *Service) CreateMaterialTypeVariant(
	ctx context.Context,
	p authorization.Principal,
	typeID uuid.UUID,
	name string,
	requestID *uuid.UUID,
) (MaterialTypeVariant, error) {
	if err := require(p, authorization.InventoryArticlesManage); err != nil {
		return MaterialTypeVariant{}, err
	}
	name, err := validateVariantName(name)
	if err != nil {
		return MaterialTypeVariant{}, err
	}
	var result MaterialTypeVariant
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := machinelogbookdb.New(tx)
		materialType, err := lockVariantType(ctx, q, typeID)
		if err != nil {
			return err
		}
		row, err := insertVariant(ctx, tx, p, materialType, name, requestID)
		if err != nil {
			return err
		}
		result = MaterialTypeVariant{ID: row.ID, MaterialTypeID: row.MaterialTypeID, Name: row.Name}
		return nil
	})
	return result, err
}

// MaterialTypeVariantTx returns the variant of a type with the given name (ignoring case after trimming) inside the
// caller's transaction, adding it to the type when it has none of that name. The configuration import uses it.
func (s *Service) MaterialTypeVariantTx(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	typeID uuid.UUID,
	name string,
	requestID *uuid.UUID,
) (MaterialTypeVariant, error) {
	if err := require(p, authorization.InventoryArticlesManage); err != nil {
		return MaterialTypeVariant{}, err
	}
	name, err := validateVariantName(name)
	if err != nil {
		return MaterialTypeVariant{}, err
	}
	q := machinelogbookdb.New(tx)
	materialType, err := lockVariantType(ctx, q, typeID)
	if err != nil {
		return MaterialTypeVariant{}, err
	}
	row, err := findOrCreateVariant(ctx, tx, p, materialType, name, requestID)
	if err != nil {
		return MaterialTypeVariant{}, err
	}
	return loadMaterialTypeVariant(ctx, q, typeID, row.ID)
}

// findOrCreateVariant resolves a trimmed name in a share-locked type: the variant of that name ignoring case, else a
// new one.
func findOrCreateVariant(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	materialType machinelogbookdb.MaterialType,
	name string,
	requestID *uuid.UUID,
) (machinelogbookdb.MaterialTypeVariant, error) {
	if MaterialKind(materialType.Kind) == KindPart {
		return machinelogbookdb.MaterialTypeVariant{}, errVariantNotAllowed
	}
	row, err := machinelogbookdb.New(tx).FindMaterialTypeVariantByName(
		ctx,
		machinelogbookdb.FindMaterialTypeVariantByNameParams{MaterialTypeID: materialType.ID, Name: name},
	)
	if err == nil {
		return row, nil
	}
	if !errors.Is(err, pgx.ErrNoRows) {
		return row, err
	}
	return insertVariant(ctx, tx, p, materialType, name, requestID)
}

// articleVariant resolves the variant name of an article in its (share-locked) type: none for parts or an empty name,
// else the type's variant of that name, created when the type has none. It returns the variant's id and stored name.
func articleVariant(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	materialType machinelogbookdb.MaterialType,
	name *string,
	requestID *uuid.UUID,
) (*uuid.UUID, *string, error) {
	if name == nil || MaterialKind(materialType.Kind) == KindPart {
		return nil, nil, nil
	}
	row, err := findOrCreateVariant(ctx, tx, p, materialType, *name, requestID)
	if err != nil {
		return nil, nil, err
	}
	return &row.ID, &row.Name, nil
}

// UpdateMaterialTypeVariant renames a variant. Its articles take the new name; an article whose name was generated
// from type, variant, colour and manufacturer is renamed with it, a typed name stays.
func (s *Service) UpdateMaterialTypeVariant(
	ctx context.Context,
	p authorization.Principal,
	typeID, id uuid.UUID,
	name string,
	requestID *uuid.UUID,
) (MaterialTypeVariant, error) {
	if err := require(p, authorization.InventoryArticlesManage); err != nil {
		return MaterialTypeVariant{}, err
	}
	name, err := validateVariantName(name)
	if err != nil {
		return MaterialTypeVariant{}, err
	}
	var result MaterialTypeVariant
	err = database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := machinelogbookdb.New(tx)
		materialType, err := lockVariantType(ctx, q, typeID)
		if err != nil {
			return err
		}
		// Articles are locked before the variant, in the order an article edit takes them (article, then the
		// variant it reads); the list is read again once the variant is locked, so articles that took the variant
		// in between follow the rename too.
		if _, err = q.ListMaterialsOfVariantForUpdate(ctx, &id); err != nil {
			return err
		}
		current, err := q.GetMaterialTypeVariantForRename(
			ctx,
			machinelogbookdb.GetMaterialTypeVariantForRenameParams{ID: id, MaterialTypeID: typeID},
		)
		if err != nil {
			return noRows(err)
		}
		if current.Name != name {
			if err = renameVariant(ctx, tx, p, materialType, current, name, requestID); err != nil {
				return err
			}
		}
		result, err = loadMaterialTypeVariant(ctx, q, typeID, id)
		return err
	})
	return result, err
}

func renameVariant(
	ctx context.Context,
	tx pgx.Tx,
	p authorization.Principal,
	materialType machinelogbookdb.MaterialType,
	current machinelogbookdb.MaterialTypeVariant,
	name string,
	requestID *uuid.UUID,
) error {
	q := machinelogbookdb.New(tx)
	if _, err := q.RenameMaterialTypeVariant(
		ctx,
		machinelogbookdb.RenameMaterialTypeVariantParams{Name: name, ID: current.ID},
	); err != nil {
		return variantConflict(err)
	}
	articles, err := q.ListMaterialsOfVariantForUpdate(ctx, &current.ID)
	if err != nil {
		return err
	}
	kind := MaterialKind(materialType.Kind)
	renamed := 0
	for _, article := range articles {
		parts := validatedMaterial{variant: &current.Name, colorName: article.ColorName, manufacturer: article.Manufacturer}
		articleNameNow := article.Name
		if generated, genErr := articleName(kind, materialType.Name, parts); genErr == nil && generated == article.Name {
			parts.variant = &name
			// A generated name that no longer fits stays as it was, like a typed one.
			if next, nextErr := articleName(kind, materialType.Name, parts); nextErr == nil {
				articleNameNow = next
			}
		}
		if articleNameNow != article.Name {
			renamed++
		}
		if err = q.RenameVariantOfMaterial(
			ctx,
			machinelogbookdb.RenameVariantOfMaterialParams{Variant: &name, Name: articleNameNow, ID: article.ID},
		); err != nil {
			return materialWriteError(err)
		}
	}
	return audit.Write(ctx, tx, audit.Event{
		ActorAccountID: accountPointer(p),
		Action:         "material_type.variant_renamed",
		ResourceType:   "material_type",
		ResourceID:     &materialType.ID,
		RequestID:      requestID,
		ChangedFields:  []string{"variants"},
		Metadata: map[string]any{
			"variantId":            current.ID.String(),
			"countArticles":        strconv.Itoa(len(articles)),
			"countArticlesRenamed": strconv.Itoa(renamed),
		},
	})
}

// DeleteMaterialTypeVariant deletes a variant that no article (deleted ones included) and no active pricing rule uses.
// Its inactive rules (cleared rates) are deleted with it.
func (s *Service) DeleteMaterialTypeVariant(
	ctx context.Context,
	p authorization.Principal,
	typeID, id uuid.UUID,
	requestID *uuid.UUID,
) error {
	if err := require(p, authorization.InventoryArticlesManage); err != nil {
		return err
	}
	return database.InTx(ctx, s.pool, func(tx pgx.Tx) error {
		q := machinelogbookdb.New(tx)
		if _, err := lockVariantType(ctx, q, typeID); err != nil {
			return err
		}
		if _, err := q.GetMaterialTypeVariantForUpdate(
			ctx,
			machinelogbookdb.GetMaterialTypeVariantForUpdateParams{ID: id, MaterialTypeID: typeID},
		); err != nil {
			return noRows(err)
		}
		referenced, err := q.MaterialTypeVariantIsReferenced(ctx, id)
		if err != nil {
			return err
		}
		if referenced {
			return apperror.Conflicting(
				"material_type_variant_in_use",
				"Articles or active pricing rules use this variant and it cannot be deleted",
			)
		}
		removed, err := q.DeleteInactivePricingRulesOfVariant(ctx, id)
		if err != nil {
			return databaseError(err)
		}
		if _, err = q.DeleteMaterialTypeVariant(ctx, id); err != nil {
			return databaseError(err)
		}
		return audit.Write(ctx, tx, audit.Event{
			ActorAccountID: accountPointer(p),
			Action:         "material_type.variant_deleted",
			ResourceType:   "material_type",
			ResourceID:     &typeID,
			RequestID:      requestID,
			ChangedFields:  []string{"variants"},
			Metadata: map[string]any{
				"variantId":                id.String(),
				"countPricingRulesRemoved": strconv.FormatInt(removed, 10),
			},
		})
	})
}
