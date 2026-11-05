package machinelogbook

import "github.com/shopspring/decimal"

// MaterialDimension is the physical quantity a unit measures. Units convert within a dimension only.
type MaterialDimension string

const (
	DimensionMass   MaterialDimension = "mass"
	DimensionLength MaterialDimension = "length"
	DimensionArea   MaterialDimension = "area"
	DimensionVolume MaterialDimension = "volume"
	DimensionCount  MaterialDimension = "count"
)

// quantityScale is the number of decimals of stored quantities, rates and costs (numeric(20, 6)).
const quantityScale = 6

type unitSpec struct {
	dimension MaterialDimension
	// factor converts one unit into the base unit of its dimension (g, mm, cm2, ml, piece).
	factor decimal.Decimal
}

// unitSpecs mirrors the SQL functions material_unit_dimension and material_unit_factor.
var unitSpecs = map[MaterialUnit]unitSpec{
	UnitGram:             {DimensionMass, decimal.NewFromInt(1)},
	UnitKilogram:         {DimensionMass, decimal.NewFromInt(1000)},
	UnitMillimeter:       {DimensionLength, decimal.NewFromInt(1)},
	UnitCentimeter:       {DimensionLength, decimal.NewFromInt(10)},
	UnitMeter:            {DimensionLength, decimal.NewFromInt(1000)},
	UnitSquareCentimeter: {DimensionArea, decimal.NewFromInt(1)},
	UnitSquareMeter:      {DimensionArea, decimal.NewFromInt(10000)},
	UnitMilliliter:       {DimensionVolume, decimal.NewFromInt(1)},
	UnitLiter:            {DimensionVolume, decimal.NewFromInt(1000)},
	UnitPiece:            {DimensionCount, decimal.NewFromInt(1)},
}

func validUnit(unit MaterialUnit) bool {
	_, ok := unitSpecs[unit]
	return ok
}

// DimensionOf returns the dimension of a unit; the second result is false for an unknown unit.
func DimensionOf(unit string) (MaterialDimension, bool) {
	spec, ok := unitSpecs[MaterialUnit(unit)]
	return spec.dimension, ok
}

// sameDimension reports whether two known units measure the same dimension.
func sameDimension(a, b string) bool {
	da, okA := DimensionOf(a)
	db, okB := DimensionOf(b)
	return okA && okB && da == db
}

// unitRatio is factor(from) / factor(to); both units must share a dimension.
func unitRatio(from, to string) decimal.Decimal {
	return unitSpecs[MaterialUnit(from)].factor.Div(unitSpecs[MaterialUnit(to)].factor)
}

// convertQuantity expresses a quantity given in unit from in unit to, rounded to the stored scale.
func convertQuantity(quantity decimal.Decimal, from, to string) decimal.Decimal {
	return quantity.Mul(unitRatio(from, to)).Round(quantityScale)
}

// convertRate expresses a price per unit from as a price per unit to: a rate converts the other way round than
// a quantity.
func convertRate(rate decimal.Decimal, from, to string) decimal.Decimal {
	return rate.Div(unitRatio(from, to)).Round(quantityScale)
}
