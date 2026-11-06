package notifyrules

import (
	"context"

	"github.com/Basmatireis/Makerspace-Core/backend/internal/authorization"
	notifyrulesdb "github.com/Basmatireis/Makerspace-Core/backend/internal/notifyrules/db"
)

// Catalog returns the triggers, collections and fields the principal may build rules from, with database options
// (machines, roles, trainings…) resolved. Entries whose permission the principal lacks are left out, which is what
// keeps a personal subscription from reading data its owner could not see anywhere else.
func (s *Service) Catalog(ctx context.Context, p authorization.Principal) (CatalogView, error) {
	lookups := newLookups(ctx, notifyrulesdb.New(s.pool))
	labels := map[OptionSource][]OptionView{}
	resolve := func(fields []Field) ([]FieldView, error) {
		views := make([]FieldView, 0, len(fields))
		for _, field := range fields {
			if field.Permission != "" && !p.Has(field.Permission) {
				continue
			}
			view := FieldView{Field: field}
			switch {
			case field.OptionsFrom != "":
				if _, ok := labels[field.OptionsFrom]; !ok {
					rows, err := lookups.optionRows(field.OptionsFrom)
					if err != nil {
						return nil, err
					}
					list := make([]OptionView, 0, len(rows))
					for _, row := range rows {
						list = append(list, OptionView{Value: row.id.String(), Label: row.name})
					}
					labels[field.OptionsFrom] = list
				}
				view.Options = labels[field.OptionsFrom]
			default:
				view.Options = make([]OptionView, 0, len(field.Options))
				for _, option := range field.Options {
					view.Options = append(view.Options, OptionView(option))
				}
			}
			views = append(views, view)
		}
		return views, nil
	}
	var view CatalogView
	var err error
	for _, trigger := range Triggers() {
		if trigger.Permission != "" && !p.Has(trigger.Permission) {
			continue
		}
		fields, err := resolve(trigger.Fields)
		if err != nil {
			return CatalogView{}, err
		}
		view.Triggers = append(view.Triggers, TriggerView{Trigger: trigger, Fields: fields})
	}
	for _, collection := range Collections() {
		if collection.Permission != "" && !p.Has(collection.Permission) {
			continue
		}
		fields, err := resolve(collection.Fields)
		if err != nil {
			return CatalogView{}, err
		}
		summary, err := resolve(SummaryFields(collection))
		if err != nil {
			return CatalogView{}, err
		}
		view.Collections = append(view.Collections, CollectionView{Collection: collection, Fields: fields, Summary: summary})
	}
	if view.RecipientFields, err = resolve(RecipientFields()); err != nil {
		return CatalogView{}, err
	}
	if view.NowFields, err = resolve(NowFields()); err != nil {
		return CatalogView{}, err
	}
	if view.OpenDayFields, err = resolve(OpenDayFields(false)); err != nil {
		return CatalogView{}, err
	}
	view.OpenDayPlaceholders = OpenDayPlaceholders()
	view.OpenDayRecipients = OpenDayRecipients()
	view.Resolutions = GenericResolutions()
	view.Repeats = []Choice{
		{string(RepeatDaily), "Every day"},
		{string(RepeatWeekdays), "Every weekday (Mon–Fri)"},
		{string(RepeatWeekly), "Every week on…"},
		{string(RepeatMonthly), "Every month on day…"},
		{string(RepeatBeforeOpenDay), "Before each open day"},
		{string(RepeatAfterOpenDay), "After each open day"},
	}
	return view, nil
}
