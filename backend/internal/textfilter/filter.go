// Package textfilter refuses text nobody should have to read.
//
// It exists for one reason and it is worth writing down, because the honest
// version is not "this makes chat nice". A word list does not make chat nice.
// What it does is stop the small number of postings that are unambiguously
// beyond the line — slurs, mostly — from ever appearing, which is the
// difference between a room somebody moderates and a room that publishes
// whatever is typed into it. Everything subtler than that is a job for
// reporting and for the host, and this deliberately does not attempt it.
//
// # What it is not
//
//   - It is not a substitute for moderation. Anything it catches, somebody was
//     already trying to say; the value is that nobody else had to see it.
//   - It is not a censor of opinion, insult, or heat. Two people arguing over a
//     game will pass this filter, and should.
//   - It is not undefeatable. Somebody determined to get a slur past a word
//     list will get a slur past a word list. The evasions handled below are the
//     lazy ones — spacing, punctuation, digit substitution, letter mashing —
//     because those are what the overwhelming majority of attempts actually
//     are.
//
// # How matching works
//
// Two normalizations of the same text, because the two kinds of term need
// opposite treatment:
//
//   - `flat` is the whole text with every non-letter removed and digits folded
//     back to the letters they imitate. It closes the gap that lets "n i g g e
//     r" and "f.u.c.k" through a naive check. Terms matched against it are
//     matched anywhere inside it, so they must be long and unambiguous — see
//     the length rule in load.
//   - `words` is the same folding applied word by word, with the boundaries
//     kept. Terms matched against it must equal a whole word, which is what
//     lets a short term be listed at all: "ass" is refused, "assess",
//     "class", and "Bass" are not. This is the Scunthorpe rule, and the tests
//     pin it.
//
// Both are checked against a run-squeezed form as well — "fuuuuck" and
// "niiigger" — but only for text somebody actually stretched. See hasStretch,
// which is what keeps "assess" from colliding with "asses".
package textfilter

import (
	_ "embed"
	"strings"
	"sync"
)

// terms.txt is the list itself, kept out of this file on purpose: the rule is
// code and the vocabulary is data, and a host who wants to add a term should
// not have to read Go to do it. Embedded rather than read from disk so a
// deployment cannot end up running with no list at all.
//
//go:embed terms.txt
var termsFile string

// Match is what was caught, for the caller to word a refusal around.
type Match struct {
	// Term is the listed word that matched. Never shown to the person who
	// typed it — quoting a slur back at somebody in an error message is the
	// one thing worse than letting it through — but useful in a log.
	Term string
}

type termList struct {
	// anywhere are terms refused wherever they appear inside the flattened
	// text. Long and unambiguous by construction.
	anywhere []string
	// whole are terms refused only as a complete word.
	whole map[string]struct{}
	// nameAnywhere are terms refused inside a username and nowhere else. See
	// CheckName, and the [name] section of terms.txt for why the [word] list
	// cannot simply be reused for this.
	nameAnywhere []string
	// squeezedAnywhere and squeezedWhole are the same two sets with runs of a
	// repeated letter collapsed, for the "fuuuck" family. A term whose squeezed
	// form is too short, or collides with an ordinary word, is left out of
	// these rather than allowed to fire — see squeezedTerm.
	squeezedAnywhere []string
	squeezedWhole    map[string]struct{}
}

var (
	loadOnce sync.Once
	loaded   termList
)

// minimumAnywhereLength is how long a term has to be before it may be matched
// inside other words.
//
// Five, and the number is the whole safety argument for the `anywhere` list: a
// four-letter sequence turns up inside real words constantly, and a filter that
// refuses a message for containing one is a filter people route around rather
// than obey. Anything shorter belongs in the `word` section, where it is
// matched as a word and cannot swallow a bystander.
const minimumAnywhereLength = 5

// load parses the embedded list once.
//
// A malformed line is skipped rather than fatal. The alternative is a server
// that will not boot because somebody left a stray heading in a word list,
// which trades a small moderation gap for a total outage.
func load() termList {
	loadOnce.Do(func() {
		list := termList{whole: make(map[string]struct{}), squeezedWhole: make(map[string]struct{})}
		section := "word"
		for _, line := range strings.Split(termsFile, "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			if strings.HasPrefix(line, "[") && strings.HasSuffix(line, "]") {
				section = strings.ToLower(strings.Trim(line, "[]"))
				continue
			}
			term := flatten(line)
			if term == "" {
				continue
			}
			switch section {
			case "name":
				list.nameAnywhere = append(list.nameAnywhere, term)
			case "anywhere":
				if len(term) < minimumAnywhereLength {
					// Listed in the wrong section. Demoted rather than
					// dropped: refusing it as a whole word is still better
					// than not refusing it, and it cannot hurt a bystander
					// there.
					list.whole[term] = struct{}{}
					if squeezed := squeezedTerm(term); squeezed != "" {
						list.squeezedWhole[squeezed] = struct{}{}
					}
					continue
				}
				list.anywhere = append(list.anywhere, term)
				// The squeezed copy has to clear the same bar as the term it
				// came from. Squeezing shortens, and a four-letter sequence
				// matched inside other words is exactly what the bar exists to
				// prevent.
				if squeezed := squeezedTerm(term); len(squeezed) >= minimumAnywhereLength {
					list.squeezedAnywhere = append(list.squeezedAnywhere, squeezed)
				}
			default:
				list.whole[term] = struct{}{}
				if squeezed := squeezedTerm(term); squeezed != "" {
					list.squeezedWhole[squeezed] = struct{}{}
				}
			}
		}
		loaded = list
	})
	return loaded
}

// Check reports the first listed term the text contains, if any.
//
// The second return is whether anything was found, so a caller reads as
// `if match, found := textfilter.Check(text); found` rather than comparing
// against an empty struct.
func Check(text string) (Match, bool) {
	list := load()
	flat := flatten(text)
	if flat == "" {
		return Match{}, false
	}
	for _, term := range list.anywhere {
		if strings.Contains(flat, term) {
			return Match{Term: term}, true
		}
	}
	if hasStretch(flat) {
		squeezedFlat := squeeze(flat)
		for _, term := range list.squeezedAnywhere {
			if strings.Contains(squeezedFlat, term) {
				return Match{Term: term}, true
			}
		}
	}
	for _, word := range words(text) {
		if _, listed := list.whole[word]; listed {
			return Match{Term: word}, true
		}
		// Only a word somebody stretched. See hasStretch: without this gate
		// "assess" squeezes to "ases" and collides with "asses".
		if !hasStretch(word) {
			continue
		}
		if _, listed := list.squeezedWhole[squeeze(word)]; listed {
			return Match{Term: word}, true
		}
	}
	return Match{}, false
}

// Clean is Check inverted, for the callers that only want the yes or no.
func Clean(text string) bool {
	_, found := Check(text)
	return !found
}

// CheckName is Check plus the rule that only applies to names.
//
// A username is a single word with no spaces in it, so the whole-word matching
// that makes Check safe for prose does almost nothing here: "fuckyou" is one
// token and matches no term. The [name] section exists for that, and is
// matched as a substring.
//
// It is a hand-picked list rather than the [word] list reused, because
// substring-matching that one would refuse Dickson, Pakistani, raccoon,
// Mustard, and suspicious — all of which are somebody's actual name.
func CheckName(name string) (Match, bool) {
	if match, found := Check(name); found {
		return match, true
	}
	flat := flatten(name)
	if flat == "" {
		return Match{}, false
	}
	for _, term := range load().nameAnywhere {
		if strings.Contains(flat, term) {
			return Match{Term: term}, true
		}
	}
	return Match{}, false
}

// CleanName is CheckName inverted.
func CleanName(name string) bool {
	_, found := CheckName(name)
	return !found
}

// leet maps the characters people substitute for letters. Only substitutions
// that are actually used: mapping every visually similar glyph would fold
// ordinary text into nonsense and produce matches nobody typed.
//
// Applied only *inside* a word — see substituted. A trailing "!" is an
// exclamation mark, and reading it as an "i" turns "shit!" into "shiti", which
// is a word on no list and is how a filter silently stops working.
var leet = map[rune]rune{
	'0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't', '8': 'b',
	'@': 'a', '$': 's', '!': 'i', '|': 'l', '+': 't',
}

// leetish reports whether a character can stand for a letter: a letter, or one
// of the substitutions above. It is what "inside a word" is judged against.
func leetish(character rune) bool {
	if character >= 'a' && character <= 'z' {
		return true
	}
	_, substituted := leet[character]
	return substituted
}

// substituted resolves one character of a lowercased string: the letter it
// stands for, and whether it stands for one at all.
//
// A leet character counts only with a letter-ish neighbour on each side, which
// is the rule that separates "sh!t" from "shit!". The cost is that a
// substitution at the very end of a word is missed — "a$$" reads as "as" — and
// that is the right way round: missing an evasion is a gap, and refusing
// everybody who ends a sentence with an exclamation mark is a broken feature.
func substituted(runes []rune, index int) (rune, bool) {
	character := runes[index]
	if character >= 'a' && character <= 'z' {
		return character, true
	}
	mapped, isLeet := leet[character]
	if !isLeet {
		return 0, false
	}
	if index == 0 || index == len(runes)-1 {
		return 0, false
	}
	if !leetish(runes[index-1]) || !leetish(runes[index+1]) {
		return 0, false
	}
	return mapped, true
}

// flatten reduces text to lowercase letters with everything else removed.
//
// The removal is the point rather than a tidying step: spacing and punctuation
// between letters is the commonest evasion there is, and stripping it means
// "f u c k" and "fuck" are the same string here. It is also why terms matched
// against this form have to be long — see minimumAnywhereLength.
func flatten(text string) string {
	runes := []rune(strings.ToLower(text))
	var builder strings.Builder
	builder.Grow(len(runes))
	for index := range runes {
		if letter, ok := substituted(runes, index); ok {
			builder.WriteRune(letter)
		}
	}
	return builder.String()
}

// words is every whole word in the text, as the whole-word terms are compared
// against.
//
// Two passes, because one boundary rule cannot serve both cases:
//
//   - Split on anything that is not a letter. This is what keeps "class" whole
//     rather than a place to find "ass" inside — the Scunthorpe rule.
//   - Split on whitespace only, then flatten. This is what catches "f.u.c.k",
//     where the punctuation *is* the word and the first pass sees four
//     single letters.
//
// Both are checked. The first alone lets a punctuated slur through; the second
// alone would read "self-assessment" as one word and is no worse for it, but
// would miss "wow,shit" typed without the space.
func words(text string) []string {
	lowered := strings.ToLower(text)
	found := make([]string, 0, 16)

	runes := []rune(lowered)
	var builder strings.Builder
	for index := range runes {
		if letter, ok := substituted(runes, index); ok {
			builder.WriteRune(letter)
			continue
		}
		if builder.Len() > 0 {
			found = append(found, builder.String())
			builder.Reset()
		}
	}
	if builder.Len() > 0 {
		found = append(found, builder.String())
	}

	for _, chunk := range strings.Fields(lowered) {
		if flattened := flatten(chunk); flattened != "" {
			found = append(found, flattened)
		}
	}
	return found
}

// squeeze collapses every run of a repeated letter to one, so "fuuuuck" and
// "fuck" are the same string.
func squeeze(text string) string {
	var builder strings.Builder
	builder.Grow(len(text))
	var previous rune = -1
	for _, character := range text {
		if character != previous {
			builder.WriteRune(character)
			previous = character
		}
	}
	return builder.String()
}

// hasStretch reports whether text holds a run of three or more of the same
// letter, which is what "somebody stretched this word" looks like.
//
// It is the gate on every squeezed comparison, and it is load-bearing. Doubled
// letters are ordinary English; tripled ones essentially never are. Without the
// gate, squeezing "assess" gives "ases" — which is also what squeezing "asses"
// gives, so an ordinary word is refused for colliding with a term nobody typed.
func hasStretch(text string) bool {
	run := 0
	var previous rune = -1
	for _, character := range text {
		if character == previous {
			run++
			if run >= 3 {
				return true
			}
			continue
		}
		previous = character
		run = 1
	}
	return false
}

// squeezedTerm is the form a term has to be listed in to catch a stretched
// spelling of itself, or "" when squeezing it would be unsafe.
//
// The squeezing happens to the *input* — "fuuuck" and "niiigger" arrive as
// "fuck" and "niger" — so every term needs a squeezed spelling of its own to be
// compared against, including terms that squeeze to themselves.
//
// Four letters minimum, so that what is left is still recognisably itself
// rather than ordinary English: "ass" squeezes to "as", and a list holding "as"
// refuses the word "as".
func squeezedTerm(term string) string {
	squeezed := squeeze(term)
	if len(squeezed) < 4 {
		return ""
	}
	return squeezed
}
