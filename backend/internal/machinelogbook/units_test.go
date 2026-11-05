package machinelogbook

import (
	"testing"

	"github.com/shopspring/decimal"
)

func TestUnitsBelongToOneDimensionEach(t *testing.T) {
	want := map[MaterialUnit]MaterialDimension{
		UnitGram: DimensionMass, UnitKilogram: DimensionMass,
		UnitMillimeter: DimensionLength, UnitCentimeter: DimensionLength, UnitMeter: DimensionLength,
		UnitSquareCentimeter: DimensionArea, UnitSquareMeter: DimensionArea,
		UnitMilliliter: DimensionVolume, UnitLiter: DimensionVolume,
		UnitPiece: DimensionCount,
	}
	if len(want) != len(unitSpecs) {
		t.Fatalf("unit table has %d units, test expects %d", len(unitSpecs), len(want))
	}
	for unit, dimension := range want {
		got, ok := DimensionOf(string(unit))
		if !ok || got != dimension || !validUnit(unit) {
			t.Errorf("%s: dimension %q valid %v, want %q", unit, got, ok, dimension)
		}
	}
	if _, ok := DimensionOf("hour"); ok || validUnit("stitch") {
		t.Error("hour and stitch are not material units")
	}
	if !sameDimension("cm", "m") || sameDimension("cm", "cm2") || sameDimension("g", "foo") || sameDimension("foo", "foo") {
		t.Error("sameDimension decides by known dimensions only")
	}
}

func TestConvertQuantityAndRateAreInverse(t *testing.T) {
	cases := []struct{ quantity, from, to, want, rate, wantRate string }{
		{"1.5", "m", "cm", "150", "3.5", "0.035"},
		{"250", "g", "kg", "0.25", "0.01", "10"},
		{"2", "m2", "cm2", "20000", "12", "0.0012"},
		{"3", "l", "ml", "3000", "4", "0.004"},
		{"12", "piece", "piece", "12", "2.5", "2.5"},
		{"0.0000004", "kg", "g", "0.0004", "0.5", "0.0005"},
	}
	for _, c := range cases {
		got := convertQuantity(decimal.RequireFromString(c.quantity), c.from, c.to)
		if !got.Equal(decimal.RequireFromString(c.want)) {
			t.Errorf("%s %s to %s = %s, want %s", c.quantity, c.from, c.to, got, c.want)
		}
		rate := convertRate(decimal.RequireFromString(c.rate), c.from, c.to)
		if !rate.Equal(decimal.RequireFromString(c.wantRate)) {
			t.Errorf("rate %s per %s as per %s = %s, want %s", c.rate, c.from, c.to, rate, c.wantRate)
		}
	}
}

func TestConvertRoundsToTheStoredScale(t *testing.T) {
	got := convertQuantity(decimal.RequireFromString("1"), "mm", "m")
	if !got.Equal(decimal.RequireFromString("0.001")) {
		t.Errorf("1 mm = %s m", got)
	}
	got = convertQuantity(decimal.RequireFromString("0.0000001"), "g", "kg")
	if !got.IsZero() {
		t.Errorf("a tenth of a microgram rounds to %s kg, want 0", got)
	}
}
