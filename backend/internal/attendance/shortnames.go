package attendance

import (
	"fmt"
	"strings"
)

// PersonName is a first and last name as stored.
type PersonName struct {
	First string
	Last  string
}

// ShortNames shortens each name to "First L." for the public presence list. People whose first names match (ignoring
// case) and whose last names start alike get as many letters of the last name as it takes to tell them apart, e.g.
// "Max Mü." and "Max Mo."; the rest keep one letter. Names that are the same in full are numbered in list order.
func ShortNames(names []PersonName) []string {
	result := make([]string, len(names))
	seen := map[string]int{}
	for index, name := range names {
		last := []rune(strings.TrimSpace(name.Last))
		letters := 1
		for other, candidate := range names {
			if other == index || !strings.EqualFold(strings.TrimSpace(candidate.First), strings.TrimSpace(name.First)) {
				continue
			}
			letters = max(letters, commonPrefix(last, []rune(strings.TrimSpace(candidate.Last)))+1)
		}
		letters = min(letters, len(last))
		short := strings.TrimSpace(name.First)
		if letters > 0 {
			short += " " + string(last[:letters])
			if letters < len(last) {
				short += "."
			}
		}
		key := strings.ToLower(short)
		seen[key]++
		if seen[key] > 1 {
			short = fmt.Sprintf("%s (%d)", short, seen[key])
		}
		result[index] = short
	}
	return result
}

// commonPrefix is the number of leading letters two last names share, ignoring case.
func commonPrefix(a, b []rune) int {
	count := 0
	for count < len(a) && count < len(b) && strings.EqualFold(string(a[count]), string(b[count])) {
		count++
	}
	return count
}
