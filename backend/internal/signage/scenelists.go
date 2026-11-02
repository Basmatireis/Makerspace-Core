package signage

import (
	"context"
	"encoding/json"
	"slices"

	signagedb "github.com/Basmatireis/Makerspace-Core/backend/internal/signage/db"
	"github.com/google/uuid"
)

const (
	maxSceneListItems = 100
	minItemSeconds    = 3
	maxItemSeconds    = 3600
	// defaultItemSeconds is the item duration where none was chosen (rules that showed one scene, Blank).
	defaultItemSeconds = 10
)

// SceneListItem is one scene of a scene list with how long it shows and how it changes to the next one.
// A one-item list shows its scene continuously; a longer list loops.
type SceneListItem struct {
	SceneID    uuid.UUID  `json:"sceneId"`
	Seconds    int        `json:"seconds"`
	Transition Transition `json:"transition"`
}

// ruleOwner is what a rule list and a default scene list belong to: a standalone display or a group (exactly
// one id is set). Every scene of the owner's lists must have the owner's aspect ratio.
type ruleOwner struct {
	DisplayID uuid.UUID
	GroupID   uuid.UUID
}

func (o ruleOwner) isGroup() bool { return o.GroupID != uuid.Nil }

// displayArg and groupArg are the nullable owner columns of the rule and default-list queries.
func (o ruleOwner) displayArg() *uuid.UUID {
	if o.isGroup() {
		return nil
	}
	id := o.DisplayID
	return &id
}

func (o ruleOwner) groupArg() *uuid.UUID {
	if !o.isGroup() {
		return nil
	}
	id := o.GroupID
	return &id
}

// checkSceneList validates the shape of a scene list (1–100 items, seconds, transitions) and returns a copy.
// field names the list in messages (scenes or defaultScenes).
func checkSceneList(list []SceneListItem, field string) ([]SceneListItem, error) {
	if len(list) == 0 || len(list) > maxSceneListItems {
		return nil, validation("%s must list 1 to %d scenes", field, maxSceneListItems)
	}
	for _, item := range list {
		if item.SceneID == uuid.Nil {
			return nil, validation("every item of %s needs a sceneId", field)
		}
		if item.Seconds < minItemSeconds || item.Seconds > maxItemSeconds {
			return nil, validation("%s item seconds must be between %d and %d", field, minItemSeconds, maxItemSeconds)
		}
		if item.Transition != TransitionCut && item.Transition != TransitionFade {
			return nil, validation("%s item transition must be cut or fade", field)
		}
	}
	return append([]SceneListItem{}, list...), nil
}

// verifySceneList checks that every scene of a list exists and has the owner's aspect ratio. The scenes are
// share-locked so that a concurrent deletion or ratio change either waits for this transaction or fails on
// the new reference.
func verifySceneList(
	ctx context.Context,
	q *signagedb.Queries,
	ratio AspectRatio,
	list []SceneListItem,
	field string,
) error {
	ids := make([]uuid.UUID, 0, len(list))
	for _, item := range list {
		ids = append(ids, item.SceneID)
	}
	ids = distinct(ids)
	rows, err := q.LockSignageScenesForShare(ctx, uuidStrings(ids))
	if err != nil {
		return err
	}
	if len(rows) != len(ids) {
		return validation("a scene of %s does not exist", field)
	}
	for _, row := range rows {
		if aspectRatioOf(row.AspectWidth, row.AspectHeight) != ratio {
			return validation("every scene of %s must have the display's aspect ratio (%s)", field, ratio)
		}
	}
	return nil
}

// sceneListColumns splits a list into the arrays the insert queries take.
func sceneListColumns(list []SceneListItem) (positions []int32, sceneIDs []string, seconds []int32, transitions []string) {
	for index, item := range list {
		positions = append(positions, int32(index))
		sceneIDs = append(sceneIDs, item.SceneID.String())
		seconds = append(seconds, int32(item.Seconds))
		transitions = append(transitions, string(item.Transition))
	}
	return positions, sceneIDs, seconds, transitions
}

// replaceRuleScenes stores a rule's scene list, replacing the previous one.
func replaceRuleScenes(ctx context.Context, q *signagedb.Queries, ruleID uuid.UUID, list []SceneListItem) error {
	if err := q.DeleteSignageRuleScenes(ctx, ruleID); err != nil {
		return err
	}
	positions, sceneIDs, seconds, transitions := sceneListColumns(list)
	return databaseError(q.InsertSignageRuleScenes(ctx, signagedb.InsertSignageRuleScenesParams{
		RuleID: ruleID, Positions: positions, SceneIds: sceneIDs, Seconds: seconds, Transitions: transitions,
	}))
}

// replaceDefaultScenes stores an owner's default scene list, replacing the previous one.
func replaceDefaultScenes(ctx context.Context, q *signagedb.Queries, owner ruleOwner, list []SceneListItem) error {
	if err := q.DeleteSignageDefaultScenes(ctx, signagedb.DeleteSignageDefaultScenesParams{
		DisplayID: owner.displayArg(), GroupID: owner.groupArg(),
	}); err != nil {
		return err
	}
	if len(list) == 0 {
		return nil
	}
	positions, sceneIDs, seconds, transitions := sceneListColumns(list)
	return databaseError(q.InsertSignageDefaultScenes(ctx, signagedb.InsertSignageDefaultScenesParams{
		DisplayID: owner.displayArg(), GroupID: owner.groupArg(),
		Positions: positions, SceneIds: sceneIDs, Seconds: seconds, Transitions: transitions,
	}))
}

// decodeSceneList reads a list that a query aggregated as JSON.
func decodeSceneList(raw string) ([]SceneListItem, error) {
	list := []SceneListItem{}
	if raw == "" {
		return list, nil
	}
	if err := json.Unmarshal([]byte(raw), &list); err != nil {
		return nil, err
	}
	return list, nil
}

// sceneListsEqual compares two lists item by item.
func sceneListsEqual(a, b []SceneListItem) bool {
	return slices.Equal(a, b)
}
