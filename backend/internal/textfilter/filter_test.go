package textfilter

import "testing"

// The half of this file that matters is the second one.
//
// A filter that refuses slurs is easy and nobody notices when it works. A
// filter that refuses "class" or "Scunthorpe" is one people learn to route
// around, and once they are routing around it they route around the rest of it
// too. So the clean cases are pinned as hard as the dirty ones.

func TestRefusesListedTerms(t *testing.T) {
	refused := []struct {
		name string
		text string
	}{
		{"a plain slur", "you absolute nigger"},
		{"one inside another word", "stopbeinganiggerabout it"},
		{"spaced out", "n i g g e r"},
		{"punctuated", "f.u.c.k this"},
		{"digit substituted", "sh1t"},
		{"symbol substituted", "f@ggot"},
		{"stretched", "fuuuuuck"},
		{"stretched slur", "niiigggeeer"},
		{"mixed case", "FaGgOt"},
		{"a short slur as a word", "what a fag"},
		{"a whole-word term with punctuation around it", "wow, shit!"},
		{"a two-word phrase run together", "child porn"},
		{"strong profanity mid-sentence", "that was a fucking blunder"},
		// Both of these refuse an innocent reading too — the idiom "a chink in
		// his armour", and somebody actually called Cock. The list takes that
		// trade knowingly, and it is pinned here so that reversing it is a
		// decision somebody makes rather than a regression.
		{"an ambiguous slur, as a whole word", "a chink in his armour"},
		{"an ambiguous profanity, as a whole word", "Van der Cock"},
	}
	for _, testCase := range refused {
		t.Run(testCase.name, func(t *testing.T) {
			if match, found := Check(testCase.text); !found {
				t.Errorf("%q passed the filter", testCase.text)
			} else if match.Term == "" {
				t.Error("a match with no term names nothing for the log")
			}
		})
	}
}

// The Scunthorpe set. Every one of these contains a listed term as a substring
// and every one of them has to pass, which is the whole reason [word] exists.
func TestAllowsOrdinaryText(t *testing.T) {
	allowed := []string{
		"good game, well played",
		"class is in session",
		"let me assess the position",
		"Scunthorpe United",
		"pass me the ball",
		"basset hound",
		"cassette",
		"the assassin opening",
		"Bass",
		"I got gassed after that game",
		"cocktail",
		"Dickson played that line too",
		"Pakistan",
		"raccoon",
		"grape",
		"analysis board",
		"titles panel",
		"the fire retardant rule",
		"a slight retardation of the clock",
		"tycoon",
		"shiitake",
		"Hitler lost the war",
		"grammar nazi",
		"documentation",
		"Massachusetts",
	}
	for _, text := range allowed {
		t.Run(text, func(t *testing.T) {
			if match, found := Check(text); found {
				t.Errorf("%q was refused for containing %q", text, match.Term)
			}
		})
	}
}

// The guard in squeezedTerm, stated as a test because the failure it prevents
// is silent: a filter that refuses the word "as" looks like a filter that
// refuses everything.
func TestSqueezingNeverShortensATermIntoAnOrdinaryWord(t *testing.T) {
	for _, text := range []string{"as", "is", "an", "to", "be", "of"} {
		if match, found := Check(text); found {
			t.Errorf("%q was refused for containing %q", text, match.Term)
		}
	}
}

func TestCleanIsCheckInverted(t *testing.T) {
	if !Clean("good game") {
		t.Error("an ordinary message did not read as clean")
	}
	if Clean("you nigger") {
		t.Error("a slur read as clean")
	}
}

// An empty message is not the filter's problem — the caller refuses it for
// being empty — but it must not be refused for containing something.
func TestEmptyTextPasses(t *testing.T) {
	for _, text := range []string{"", "   ", "!!!", "1234"} {
		if _, found := Check(text); found {
			t.Errorf("%q was refused", text)
		}
	}
}

// Terms listed in the wrong section are demoted rather than dropped, because
// the alternative is a term somebody added that silently does nothing.
func TestShortAnywhereTermsAreDemotedToWholeWords(t *testing.T) {
	list := load()
	for _, term := range list.anywhere {
		if len(term) < minimumAnywhereLength {
			t.Errorf("%q is matched inside other words and is too short to be", term)
		}
	}
	for _, term := range list.squeezedAnywhere {
		if len(term) < minimumAnywhereLength {
			t.Errorf("squeezed %q is matched inside other words and is too short to be", term)
		}
	}
}

// The list has to actually load. An embed that resolved to nothing would make
// every test above pass except this one.
func TestListLoads(t *testing.T) {
	list := load()
	if len(list.anywhere) == 0 {
		t.Fatal("no anywhere terms loaded")
	}
	if len(list.whole) == 0 {
		t.Fatal("no whole-word terms loaded")
	}
}

// A username is one word, so the whole-word rule that keeps chat readable does
// almost nothing for it. CheckName is the answer, and this is the pair of lists
// that says what it may and may not cost.
func TestNameFilteringCatchesCompounds(t *testing.T) {
	for _, name := range []string{"fuckyou", "xXshitlordXx", "BigBastard", "retardo"} {
		if _, found := CheckName(name); !found {
			t.Errorf("%q was accepted as a name", name)
		}
	}
}

// The absences documented in the [name] section of terms.txt, pinned. Every one
// of these is somebody's actual name or an ordinary word, and every one of them
// contains a term the [word] list holds.
func TestNameFilteringLeavesRealNamesAlone(t *testing.T) {
	realNames := []string{
		"Scunthorpe", // cunt
		"Kikelomo",   // kike
		"Vandyke",    // dyke
		"Dickson",    // dick
		"Raccoon",    // coon
		"Pakistani",  // paki
		"Sparse",     // arse
		"Grapeseed",  // rape
		"Uranus",     // anus
		"Suspicious", // spic
		"Mustard",    // tard
		"Gookin",     // gook
		"Bassett",    // ass
		"Classic",    // ass
		"Hancock",    // cock
	}
	for _, name := range realNames {
		if match, found := CheckName(name); found {
			t.Errorf("%q was refused as a name for containing %q", name, match.Term)
		}
	}
}

// The name rule is narrower than the general one in one direction only: every
// term the general filter refuses, a name filter refuses too.
func TestNameFilteringIsAtLeastAsStrictAsTheGeneralOne(t *testing.T) {
	for _, text := range []string{"nigger", "faggot", "fag", "ass", "cunt"} {
		if _, found := CheckName(text); !found {
			t.Errorf("%q passed the name filter but not the general one", text)
		}
	}
}
