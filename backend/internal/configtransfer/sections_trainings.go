package configtransfer

import (
	"context"
	"fmt"
	"slices"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	configtransferdb "github.com/Basmatireis/Makerspace-Core/backend/internal/configtransfer/db"
	"github.com/Basmatireis/Makerspace-Core/backend/internal/trainings"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

// Competencies and trainings: natural key name. Training records are personal data and never travel.

type competencyEntry struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Active      bool    `json:"active"`
	SortOrder   int32   `json:"sortOrder"`
}

func competenciesSection() section {
	return define(
		SectionCompetencies,
		permissions(authorization.TrainingsManage),
		permissions(authorization.TrainingsManage),
		func(ctx context.Context, q *configtransferdb.Queries) ([]competencyEntry, error) {
			rows, err := q.ListCompetencyCategories(ctx)
			if err != nil {
				return nil, err
			}
			items := make([]competencyEntry, 0, len(rows))
			for _, row := range rows {
				items = append(items, competencyEntry{
					Name: row.Name, Description: row.Description, Active: row.Active, SortOrder: row.SortOrder,
				})
			}
			return items, nil
		},
		func(items *[]competencyEntry) error {
			names := make([]*string, len(*items))
			for i := range *items {
				names[i] = &(*items)[i].Name
				(*items)[i].Description = trimmed((*items)[i].Description)
			}
			return checkNames("competency", names, 120)
		},
		applyCompetencies,
	)
}

func applyCompetencies(r *run, items *[]competencyEntry) (func() error, error) {
	rows, err := r.q.ListCompetencyCategories(r.ctx)
	if err != nil {
		return nil, err
	}
	existing := map[string]configtransferdb.ListCompetencyCategoriesRow{}
	for _, row := range rows {
		existing[nameKey(row.Name)] = row
	}
	inFile := map[string]bool{}
	for _, item := range *items {
		inFile[nameKey(item.Name)] = true
		input := trainings.CompetencyCategoryInput{
			Name: item.Name, Description: item.Description, Active: item.Active, SortOrder: item.SortOrder,
		}
		current, found := existing[nameKey(item.Name)]
		switch {
		case !found:
			_, err = r.attempt(item.Name, ActionCreate, "", func(tx pgx.Tx) error {
				_, err := r.svc.Trainings.CreateCompetencyCategoryTx(r.ctx, tx, r.p, input, r.requestID)
				return err
			})
		case r.mode == ModeInsert:
			r.skip(item.Name, reasonExists)
		case current.Name == item.Name && sameText(current.Description, item.Description) &&
			current.Active == item.Active && current.SortOrder == item.SortOrder:
			r.skip(item.Name, reasonUnchanged)
		default:
			_, err = r.attempt(item.Name, ActionUpdate, "", func(tx pgx.Tx) error {
				_, err := r.svc.Trainings.UpdateCompetencyCategoryTx(
					r.ctx, tx, r.p, current.ID, current.Version, input, r.requestID,
				)
				return err
			})
		}
		if err != nil {
			return nil, err
		}
	}
	return func() error {
		for _, row := range rows {
			if inFile[nameKey(row.Name)] {
				continue
			}
			if row.TrainingCount == 0 {
				if _, err := r.attempt(row.Name, ActionDelete, "", func(tx pgx.Tx) error {
					return r.svc.Trainings.DeleteCompetencyCategoryTx(r.ctx, tx, r.p, row.ID, row.Version, r.requestID)
				}); err != nil {
					return err
				}
				continue
			}
			if !row.Active {
				r.keep(row.Name, "Trainings feed it; it stays inactive.")
				continue
			}
			if _, err := r.attempt(row.Name, ActionDeactivate, "Trainings feed it.", func(tx pgx.Tx) error {
				_, err := r.svc.Trainings.UpdateCompetencyCategoryTx(r.ctx, tx, r.p, row.ID, row.Version,
					trainings.CompetencyCategoryInput{
						Name: row.Name, Description: row.Description, Active: false, SortOrder: row.SortOrder,
					}, r.requestID)
				return err
			}); err != nil {
				return err
			}
		}
		return nil
	}, nil
}

type trainingEntry struct {
	Name        string  `json:"name"`
	Description *string `json:"description"`
	Active      bool    `json:"active"`
	SortOrder   int32   `json:"sortOrder"`
	// Competencies and MachineTypes are names of entries in those sections.
	Competencies []string `json:"competencies"`
	MachineTypes []string `json:"machineTypes"`
}

func trainingsSection() section {
	return define(
		SectionTrainings,
		permissions(authorization.TrainingsManage),
		permissions(authorization.TrainingsManage),
		func(ctx context.Context, q *configtransferdb.Queries) ([]trainingEntry, error) {
			rows, err := q.ListTrainings(ctx)
			if err != nil {
				return nil, err
			}
			items := make([]trainingEntry, 0, len(rows))
			for _, row := range rows {
				items = append(items, trainingEntry{
					Name:         row.Name,
					Description:  row.Description,
					Active:       row.Active,
					SortOrder:    row.SortOrder,
					Competencies: sortedStrings(row.Competencies),
					MachineTypes: sortedStrings(row.MachineTypes),
				})
			}
			return items, nil
		},
		func(items *[]trainingEntry) error {
			names := make([]*string, len(*items))
			for i := range *items {
				item := &(*items)[i]
				names[i] = &item.Name
				item.Description = trimmed(item.Description)
				if len(item.Competencies) > 50 || len(item.MachineTypes) > 100 {
					return fmt.Errorf("training %q links too many competencies or machine types", item.Name)
				}
				item.Competencies = sortedStrings(item.Competencies)
				item.MachineTypes = sortedStrings(item.MachineTypes)
			}
			return checkNames("training", names, 150)
		},
		applyTrainings,
	)
}

// sameNames compares two name lists ignoring case and order.
func sameNames(a, b []string) bool {
	keys := func(values []string) []string {
		result := make([]string, 0, len(values))
		for _, value := range values {
			result = append(result, nameKey(value))
		}
		return sortedStrings(result)
	}
	return slices.Equal(keys(a), keys(b))
}

func applyTrainings(r *run, items *[]trainingEntry) (func() error, error) {
	rows, err := r.q.ListTrainings(r.ctx)
	if err != nil {
		return nil, err
	}
	existing := map[string]configtransferdb.ListTrainingsRow{}
	for _, row := range rows {
		existing[nameKey(row.Name)] = row
	}
	// The competencies section runs first, so its entries already exist here.
	competencyRows, err := r.q.ListCompetencyCategories(r.ctx)
	if err != nil {
		return nil, err
	}
	competencies := map[string]uuid.UUID{}
	for _, row := range competencyRows {
		competencies[nameKey(row.Name)] = row.ID
	}
	typeRows, err := r.q.ListMachineTypes(r.ctx)
	if err != nil {
		return nil, err
	}
	machineTypes := map[string]uuid.UUID{}
	for _, row := range typeRows {
		machineTypes[nameKey(row.Name)] = row.ID
	}
	inFile := map[string]bool{}
	for _, item := range *items {
		inFile[nameKey(item.Name)] = true
		current, found := existing[nameKey(item.Name)]
		if found && r.mode == ModeInsert {
			r.skip(item.Name, reasonExists)
			continue
		}
		input := trainings.TrainingInput{
			Name: item.Name, Description: item.Description, Active: item.Active, SortOrder: item.SortOrder,
			CompetencyIDs: []uuid.UUID{}, MachineTypeIDs: []uuid.UUID{},
		}
		missing := ""
		for _, name := range item.Competencies {
			id, ok := competencies[nameKey(name)]
			if !ok {
				missing = fmt.Sprintf("The competency %q does not exist.", name)
				r.conflict(item.Name, "competency_missing", missing)
				break
			}
			input.CompetencyIDs = append(input.CompetencyIDs, id)
		}
		if missing != "" {
			continue
		}
		for _, name := range item.MachineTypes {
			id, ok := machineTypes[nameKey(name)]
			if !ok {
				missing = fmt.Sprintf("The machine type %q does not exist.", name)
				r.conflict(item.Name, "machine_type_missing", missing)
				break
			}
			input.MachineTypeIDs = append(input.MachineTypeIDs, id)
		}
		if missing != "" {
			continue
		}
		switch {
		case !found:
			_, err = r.attempt(item.Name, ActionCreate, "", func(tx pgx.Tx) error {
				_, err := r.svc.Trainings.CreateTrainingTx(r.ctx, tx, r.p, input, r.requestID)
				return err
			})
		case current.Name == item.Name && sameText(current.Description, item.Description) &&
			current.Active == item.Active && current.SortOrder == item.SortOrder &&
			sameNames(current.Competencies, item.Competencies) && sameNames(current.MachineTypes, item.MachineTypes):
			r.skip(item.Name, reasonUnchanged)
		default:
			_, err = r.attempt(item.Name, ActionUpdate, "", func(tx pgx.Tx) error {
				_, err := r.svc.Trainings.UpdateTrainingTx(r.ctx, tx, r.p, current.ID, current.Version, input, r.requestID)
				return err
			})
		}
		if err != nil {
			return nil, err
		}
	}
	return func() error {
		for _, row := range rows {
			if inFile[nameKey(row.Name)] {
				continue
			}
			if row.RecordCount == 0 {
				if _, err := r.attempt(row.Name, ActionDelete, "", func(tx pgx.Tx) error {
					return r.svc.Trainings.DeleteTrainingTx(r.ctx, tx, r.p, row.ID, row.Version, r.requestID)
				}); err != nil {
					return err
				}
				continue
			}
			if !row.Active {
				r.keep(row.Name, "People hold records of it; it stays inactive.")
				continue
			}
			if _, err := r.attempt(row.Name, ActionDeactivate, "People hold records of it.", func(tx pgx.Tx) error {
				training, err := r.svc.Trainings.TrainingTx(r.ctx, tx, row.ID)
				if err != nil {
					return err
				}
				_, err = r.svc.Trainings.UpdateTrainingTx(r.ctx, tx, r.p, row.ID, row.Version, trainings.TrainingInput{
					Name: training.Name, Description: training.Description, Active: false, SortOrder: training.SortOrder,
					CompetencyIDs: training.CompetencyIDs, MachineTypeIDs: training.MachineTypeIDs,
				}, r.requestID)
				return err
			}); err != nil {
				return err
			}
		}
		return nil
	}, nil
}
