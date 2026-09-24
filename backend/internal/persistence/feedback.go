package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
)

// The feedback board: bugs and suggestions, in public, with the host answering.
//
// This is the third place in the codebase where somebody tells the host
// something, and the three are deliberately different things:
//
//   - reports.go is private and about a person. It is read once, acted on, and
//     never shown to anybody but the host.
//   - moderation.go is the host acting on one of those.
//   - this file is public and about the game. Everybody can read it, anybody
//     verified can add to it, and the whole value is that the answer is visible
//     to the next person who hits the same bug.
//
// # Why it is public
//
// A private bug form gets the same bug reported forty times, and forty people
// each waiting to hear back. A board gets it reported once and upvoted
// thirty-nine times, which is both less work to read and a better measurement:
// the count is what says which of two bugs to fix first. It also gives an
// answer a place to live. "Known issue, fixed in the next build" written once
// on an item is worth more than the same sentence typed into thirty-nine
// private replies nobody else ever sees.
//
// # Why the author is a snapshot, like a report's
//
// AuthorName is stored beside AuthorUserID rather than joined at read time, for
// the reason reports.go gives at more length: a name can change, and a thread
// that reads "player 4f2a said" is one nobody can follow. The id is what stays
// authoritative for "may I delete this" and for the vote tally; the name is
// what the thread reads as. An account that is deleted has both rewritten by
// AnonymizeFeedbackAuthorship rather than having its posts removed, because a
// thread belongs to everybody in it — the same reasoning the privacy policy
// gives for not erasing a shared game.

/* ------------------------------------------------------------- what it is -- */

// FeedbackKind separates the two things this board carries.
//
// Two rather than one, because they are read differently and answered
// differently: a bug is a claim about what the software does, which is either
// true or not, and a suggestion is a claim about what it should do, which is an
// opinion the vote count is a measurement of. Filing them in one pile makes
// both harder to scan.
type FeedbackKind string

const (
	// FeedbackBug is something that does not work.
	FeedbackBug FeedbackKind = "bug"
	// FeedbackSuggestion is something that could be better.
	FeedbackSuggestion FeedbackKind = "suggestion"
)

// FeedbackKinds is both, in the order the board offers them.
var FeedbackKinds = []FeedbackKind{FeedbackBug, FeedbackSuggestion}

// Valid reports whether this is one of the two.
func (kind FeedbackKind) Valid() bool {
	return kind == FeedbackBug || kind == FeedbackSuggestion
}

// Label is the kind in the words the board shows.
func (kind FeedbackKind) Label() string {
	switch kind {
	case FeedbackBug:
		return "Bug"
	case FeedbackSuggestion:
		return "Suggestion"
	}
	return string(kind)
}

// FeedbackStatus is the host's answer, and the only field on an item that only
// the host may write.
//
// Five, shared by both kinds, with labels that differ per kind — see
// StatusLabel. One set rather than one per kind because the *lifecycle* is the
// same shape for both (nobody has looked; it is agreed; it happened; it is not
// going to; it is already somewhere else) and two parallel sets would mean two
// filters, two sort rules, and two places to forget one.
type FeedbackStatus string

const (
	// FeedbackOpen is one nobody has answered yet. Every item starts here,
	// including the host's own — a known bug is posted and then marked.
	FeedbackOpen FeedbackStatus = "open"
	// FeedbackAccepted is one the host has agreed with: a bug reproduced, or a
	// suggestion that is going to happen.
	FeedbackAccepted FeedbackStatus = "accepted"
	// FeedbackDone is one that has shipped.
	FeedbackDone FeedbackStatus = "done"
	// FeedbackDeclined is one the host read and is not going to act on. Not the
	// same as ignoring it, and that difference is the point of saying so: an
	// answered no is worth more to the person who filed it than silence.
	FeedbackDeclined FeedbackStatus = "declined"
	// FeedbackDuplicate is one already filed. DuplicateOf points at the item
	// that carries the discussion, so the vote is not simply lost.
	FeedbackDuplicate FeedbackStatus = "duplicate"
)

// FeedbackStatuses is every status there is, in lifecycle order.
var FeedbackStatuses = []FeedbackStatus{
	FeedbackOpen,
	FeedbackAccepted,
	FeedbackDone,
	FeedbackDeclined,
	FeedbackDuplicate,
}

// Valid reports whether this is one of the five.
func (status FeedbackStatus) Valid() bool {
	for _, known := range FeedbackStatuses {
		if status == known {
			return true
		}
	}
	return false
}

// Settled reports whether the host is finished with this one.
//
// What the default sort uses to keep answered items below live ones — see
// FeedbackFilter. A board sorted purely by votes buries this year's bug under
// last year's fixed one, which is how a board stops being worth opening.
func (status FeedbackStatus) Settled() bool {
	switch status {
	case FeedbackDone, FeedbackDeclined, FeedbackDuplicate:
		return true
	}
	return false
}

// StatusLabel is the status in the words the board shows, which depend on what
// is being answered: a bug is fixed and a suggestion ships, and one word for
// both would be wrong for one of them every time.
func StatusLabel(kind FeedbackKind, status FeedbackStatus) string {
	switch status {
	case FeedbackOpen:
		return "Open"
	case FeedbackAccepted:
		if kind == FeedbackBug {
			return "Known issue"
		}
		return "Planned"
	case FeedbackDone:
		if kind == FeedbackBug {
			return "Fixed"
		}
		return "Shipped"
	case FeedbackDeclined:
		if kind == FeedbackBug {
			return "Not a bug"
		}
		return "Declined"
	case FeedbackDuplicate:
		return "Duplicate"
	}
	return string(status)
}

/* ----------------------------------------------------------- the refusals -- */

var (
	ErrUnknownFeedbackKind     = errors.New("unknown feedback kind")
	ErrUnknownFeedbackStatus   = errors.New("unknown feedback status")
	ErrFeedbackNotFound        = errors.New("feedback not found")
	ErrFeedbackCommentNotFound = errors.New("comment not found")
	// ErrFeedbackNeedsTitle and ErrFeedbackNeedsBody are the two ways a post
	// arrives with nothing in it. Sentinels rather than plain errors so the
	// route answers 400 rather than 500 — the same reasoning reports.go gives.
	ErrFeedbackNeedsTitle = errors.New("give this a title")
	ErrFeedbackNeedsBody  = errors.New("say a little more about it")
	ErrFeedbackNeedsText  = errors.New("write something first")
	// ErrFeedbackBadLink is a link that is not one. Only http and https are
	// accepted: this address is rendered as a tappable link on everybody
	// else's screen, and `javascript:` in that position is an attack rather
	// than a citation.
	ErrFeedbackBadLink = errors.New("links must start with http:// or https://")
	// ErrFeedbackDuplicateOfItself is the one self-reference worth refusing.
	ErrFeedbackDuplicateOfItself = errors.New("an item cannot duplicate itself")
)

const (
	// MaximumFeedbackTitleRunes bounds the one line the board lists. Long
	// enough for a sentence that says what the bug is, short enough that a
	// hundred of them still scan as a list.
	MaximumFeedbackTitleRunes = 120
	// MaximumFeedbackBodyRunes bounds the report itself. Generous, because
	// "what I did, what happened, what I expected" is three paragraphs and
	// cutting somebody off mid-repro is how a report arrives unusable.
	MaximumFeedbackBodyRunes = 4000
	// MaximumFeedbackCommentRunes bounds a reply. Smaller than a post on
	// purpose: a comment that wants four thousand characters is a post.
	MaximumFeedbackCommentRunes = 2000
	// MaximumFeedbackNoteRunes bounds the host's answer beside the status.
	// A sentence or two — the long version belongs in a comment, where it is
	// part of the thread rather than a label on it.
	MaximumFeedbackNoteRunes = 400
	// MaximumFeedbackLinkRunes bounds an address. Longer than any issue URL
	// and shorter than a place to hide a payload.
	MaximumFeedbackLinkRunes = 500
	// MaximumFeedbackClientRunes bounds each of the two lines a client may say
	// about itself. "1.0.0" and "iOS 26.1" are the shapes expected; the limit
	// is what stops the field becoming a second body.
	MaximumFeedbackClientRunes = 80
)

/* ------------------------------------------------------------- the shapes -- */

// FeedbackItem is one post on the board, as stored and as the board shows it.
type FeedbackItem struct {
	ItemID string       `json:"itemId"`
	Kind   FeedbackKind `json:"kind"`
	Title  string       `json:"title"`
	Body   string       `json:"body,omitempty"`
	// AuthorUserID is who may delete it, and AuthorName is what the thread
	// reads as. See the note at the top of this file about the snapshot.
	AuthorUserID string `json:"authorUserId,omitempty"`
	AuthorName   string `json:"authorName"`
	// FromHost marks the host's own posts, which the board badges. Stored
	// rather than derived from the admin flag at read time, because the point
	// of the badge is what was true when it was written: an account that stops
	// being an administrator should not silently un-badge a year of answers,
	// and one that becomes an administrator should not retroactively acquire
	// them.
	FromHost bool           `json:"fromHost,omitempty"`
	Status   FeedbackStatus `json:"status"`
	// StatusLabel is the status in this item's own words, resolved here rather
	// than in the client: the wording depends on the kind, and a client that
	// restated the table would drift from it. The same reasoning
	// /api/reports/categories is built on.
	StatusLabel string `json:"statusLabel"`
	// StatusNote is the host's sentence beside the status: why it was
	// declined, which build fixes it.
	StatusNote string `json:"statusNote,omitempty"`
	// LinkURL is somewhere else to look: an issue, a thread, a video of the
	// bug happening. Optional, and validated to http(s) — see ErrFeedbackBadLink.
	LinkURL string `json:"linkUrl,omitempty"`
	// GameID is the game it happened in, when the report came from a board.
	// The one field that turns "the clock did something odd" into something
	// reproducible, which is why the finished-game card offers to fill it in.
	GameID string `json:"gameId,omitempty"`
	// AppVersion and Platform are what the reporter was running. Taken from
	// the client's own word rather than sniffed from the request, because the
	// user agent of a React Native app says nothing useful and the build
	// number is the thing that actually matters.
	AppVersion string `json:"appVersion,omitempty"`
	Platform   string `json:"platform,omitempty"`
	// DuplicateOf is the item this one was folded into, set with the duplicate
	// status. Kept as a plain id rather than a foreign key for the same reason
	// the table has none at all — see ensureFeedbackSchema.
	DuplicateOf string `json:"duplicateOf,omitempty"`
	// Pinned holds an item at the top of the board. For the handful of things
	// everybody is about to hit, which is the whole reason the host posts here
	// at all.
	Pinned bool `json:"pinned,omitempty"`
	// Hidden takes an item off the public board without deleting it. Spam and
	// abuse go here rather than to DELETE, so that the row survives long enough
	// for the account behind it to be dealt with.
	Hidden bool `json:"hidden,omitempty"`
	// Votes is the tally, and YouVoted is whether the account asking is in it.
	// Counted at read time rather than kept in a column: this board holds
	// hundreds of rows rather than millions, and a stored count is a number
	// that can be wrong.
	Votes    int  `json:"votes"`
	YouVoted bool `json:"youVoted,omitempty"`
	Comments int  `json:"comments"`
	// Thread is the replies, and is filled only by FeedbackItemByID — the list
	// route leaves it empty rather than returning every comment on the board.
	Thread          []FeedbackComment `json:"thread,omitempty"`
	CreatedAtUnixMs int64             `json:"createdAtUnixMs"`
	UpdatedAtUnixMs int64             `json:"updatedAtUnixMs"`
}

// FeedbackComment is one reply.
type FeedbackComment struct {
	CommentID    string `json:"commentId"`
	ItemID       string `json:"itemId"`
	AuthorUserID string `json:"authorUserId,omitempty"`
	AuthorName   string `json:"authorName"`
	FromHost     bool   `json:"fromHost,omitempty"`
	Body         string `json:"body"`
	// Hidden comments are not returned to anybody but the host, so this is
	// only ever true on the admin's copy.
	Hidden          bool  `json:"hidden,omitempty"`
	CreatedAtUnixMs int64 `json:"createdAtUnixMs"`
}

// NewFeedbackItem is a post about to be made.
type NewFeedbackItem struct {
	Kind         FeedbackKind
	Title        string
	Body         string
	AuthorUserID string
	AuthorName   string
	FromHost     bool
	LinkURL      string
	GameID       string
	AppVersion   string
	Platform     string
}

// NewFeedbackComment is a reply about to be made.
type NewFeedbackComment struct {
	ItemID       string
	AuthorUserID string
	AuthorName   string
	FromHost     bool
	Body         string
}

// FeedbackEdit is the host's pass over an item: everything about it that is the
// host's to say.
//
// Every field is a pointer so that "not mentioned" and "set to empty" are
// different requests. A PATCH that clears a status note and a PATCH that leaves
// it alone are both a body without the old text in it, and without pointers the
// two are indistinguishable.
type FeedbackEdit struct {
	Kind        *FeedbackKind
	Status      *FeedbackStatus
	StatusNote  *string
	LinkURL     *string
	DuplicateOf *string
	Pinned      *bool
	Hidden      *bool
	Title       *string
}

// FeedbackSort is the order the board is read in.
type FeedbackSort string

const (
	// FeedbackTop is the default: what most people want, with the host's
	// pinned items above it and anything already answered below.
	FeedbackTop FeedbackSort = "top"
	// FeedbackNewest is the other one worth having: what has just come in,
	// which is how the host reads the board.
	FeedbackNewest FeedbackSort = "new"
)

// FeedbackFilter narrows the board.
type FeedbackFilter struct {
	// Kind and Status are exact, and empty means every one of them.
	Kind   FeedbackKind
	Status FeedbackStatus
	// Search matches the title and the body, which is the one query worth
	// having: it is what somebody does before posting to find out whether their
	// bug is already here.
	Search string
	Sort   FeedbackSort
	// ViewerUserID is who is asking, which decides YouVoted. Empty for a
	// signed-out reader, who sees the tally and no marks on it.
	ViewerUserID string
	// IncludeHidden is the host's view. Off for everybody else, so a hidden
	// item is genuinely absent rather than merely unlisted.
	IncludeHidden bool
	Limit         int
	Offset        int
}

// FeedbackPage is one screen of the board, with the totals the client would
// otherwise have to guess at.
type FeedbackPage struct {
	Items []FeedbackItem `json:"items"`
	// Total is how many match the filter, so the client can page.
	Total int `json:"total"`
	// OpenBugs and OpenSuggestions are the two counts worth showing beside the
	// tabs, and they do not move with the filter — the point of them is to be
	// visible while looking at something else, the same as ReportPage.Open.
	OpenBugs        int `json:"openBugs"`
	OpenSuggestions int `json:"openSuggestions"`
}

/* ------------------------------------------------------------ the schema -- */

// ensureFeedbackSchema creates the board.
//
// No foreign key to `accounts` on any of the three tables, which is the same
// choice reports.go makes and for a related reason: an account that is deleted
// has its authorship rewritten rather than its posts removed — see
// AnonymizeFeedbackAuthorship — and a cascade would delete the half of a
// conversation that other people are still reading. Votes are the exception in
// spirit but not in mechanism: they are cleared by that same function, because
// a tally should not count somebody who has left.
//
// The two child tables reference their item by plain id for the same reason
// they could safely use a key: deleting an item deletes its votes and comments
// explicitly, inside one transaction, so the cascade would only be doing what
// DeleteFeedbackItem already does — and doing it in a way that hides the cost
// of getting the order wrong.
func (store *Store) ensureFeedbackSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS feedback_items (
    item_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('bug', 'suggestion')),
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    author_user_id TEXT NOT NULL DEFAULT '',
    author_name TEXT NOT NULL DEFAULT '',
    from_host INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'accepted', 'done', 'declined', 'duplicate')),
    status_note TEXT NOT NULL DEFAULT '',
    link_url TEXT NOT NULL DEFAULT '',
    game_id TEXT NOT NULL DEFAULT '',
    app_version TEXT NOT NULL DEFAULT '',
    platform TEXT NOT NULL DEFAULT '',
    duplicate_of TEXT NOT NULL DEFAULT '',
    pinned INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at_unix_ms INTEGER NOT NULL,
    updated_at_unix_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS feedback_votes (
    item_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    created_at_unix_ms INTEGER NOT NULL,
    PRIMARY KEY (item_id, user_id)
);

CREATE TABLE IF NOT EXISTS feedback_comments (
    comment_id TEXT PRIMARY KEY,
    item_id TEXT NOT NULL,
    author_user_id TEXT NOT NULL DEFAULT '',
    author_name TEXT NOT NULL DEFAULT '',
    from_host INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at_unix_ms INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS feedback_items_board_idx
    ON feedback_items(hidden, kind, status, created_at_unix_ms DESC);
CREATE INDEX IF NOT EXISTS feedback_items_author_idx
    ON feedback_items(author_user_id, created_at_unix_ms DESC);
CREATE INDEX IF NOT EXISTS feedback_votes_user_idx
    ON feedback_votes(user_id);
CREATE INDEX IF NOT EXISTS feedback_comments_item_idx
    ON feedback_comments(item_id, created_at_unix_ms);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate feedback schema: %w", err)
	}
	return nil
}

/* -------------------------------------------------------------- the posts -- */

// CreateFeedbackItem posts one.
func (store *Store) CreateFeedbackItem(
	ctx context.Context,
	input NewFeedbackItem,
) (FeedbackItem, error) {
	if !input.Kind.Valid() {
		return FeedbackItem{}, fmt.Errorf("%w: %q", ErrUnknownFeedbackKind, input.Kind)
	}
	title := truncateRunes(strings.TrimSpace(input.Title), MaximumFeedbackTitleRunes)
	if title == "" {
		return FeedbackItem{}, ErrFeedbackNeedsTitle
	}
	body := truncateRunes(strings.TrimSpace(input.Body), MaximumFeedbackBodyRunes)
	// A bug with a title and nothing else is not reproducible, and the person
	// who could have said how is the one who just closed the form. A
	// suggestion can stand on its title alone — "add a rematch button" is the
	// whole idea — so the requirement is asked of one kind and not the other.
	if input.Kind == FeedbackBug && body == "" {
		return FeedbackItem{}, ErrFeedbackNeedsBody
	}
	link, err := normalizeFeedbackLink(input.LinkURL)
	if err != nil {
		return FeedbackItem{}, err
	}

	itemID, err := randomToken(9)
	if err != nil {
		return FeedbackItem{}, fmt.Errorf("create feedback: %w", err)
	}
	now := time.Now().UnixMilli()
	item := FeedbackItem{
		ItemID:          itemID,
		Kind:            input.Kind,
		Title:           title,
		Body:            body,
		AuthorUserID:    strings.TrimSpace(input.AuthorUserID),
		AuthorName:      strings.TrimSpace(input.AuthorName),
		FromHost:        input.FromHost,
		Status:          FeedbackOpen,
		LinkURL:         link,
		GameID:          strings.TrimSpace(input.GameID),
		AppVersion:      truncateRunes(strings.TrimSpace(input.AppVersion), MaximumFeedbackClientRunes),
		Platform:        truncateRunes(strings.TrimSpace(input.Platform), MaximumFeedbackClientRunes),
		CreatedAtUnixMs: now,
		UpdatedAtUnixMs: now,
	}
	item.StatusLabel = StatusLabel(item.Kind, item.Status)
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO feedback_items (
    item_id, kind, title, body, author_user_id, author_name, from_host,
    status, status_note, link_url, game_id, app_version, platform,
    duplicate_of, pinned, hidden, created_at_unix_ms, updated_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', '', ?, ?, ?, ?, '', 0, 0, ?, ?)
`,
		item.ItemID, string(item.Kind), item.Title, item.Body,
		item.AuthorUserID, item.AuthorName, boolToInt(item.FromHost),
		item.LinkURL, item.GameID, item.AppVersion, item.Platform, now, now,
	); err != nil {
		return FeedbackItem{}, fmt.Errorf("create feedback: %w", err)
	}

	// The author's own vote, cast for them.
	//
	// Not a nicety: a board where posting and upvoting are separate acts ranks
	// a bug three people hit below one that two people voted for, purely
	// because the reporter never thought to vote for their own report. Filing
	// something *is* the strongest statement that you want it fixed.
	if item.AuthorUserID != "" {
		if _, err := store.db.ExecContext(ctx, `
INSERT OR IGNORE INTO feedback_votes (item_id, user_id, created_at_unix_ms)
VALUES (?, ?, ?)
`, item.ItemID, item.AuthorUserID, now); err != nil {
			return FeedbackItem{}, fmt.Errorf("create feedback: author vote: %w", err)
		}
		item.Votes = 1
		item.YouVoted = true
	}
	return item, nil
}

// normalizeFeedbackLink accepts an address worth rendering as a link, and
// refuses everything else.
//
// An allowlist of two schemes rather than a check for the ones known to be
// dangerous: this string is handed to every reader's browser as something to
// open, and the set of schemes that can do something surprising is not one
// anybody can enumerate in advance.
func normalizeFeedbackLink(raw string) (string, error) {
	trimmed := truncateRunes(strings.TrimSpace(raw), MaximumFeedbackLinkRunes)
	if trimmed == "" {
		return "", nil
	}
	parsed, err := url.Parse(trimmed)
	if err != nil {
		return "", ErrFeedbackBadLink
	}
	switch strings.ToLower(parsed.Scheme) {
	case "http", "https":
	default:
		return "", ErrFeedbackBadLink
	}
	if parsed.Host == "" {
		return "", ErrFeedbackBadLink
	}
	return trimmed, nil
}

// FeedbackItemsSinceBy counts what one account has posted lately, which is what
// the rate limit is spent against.
//
// Counted in the database rather than in memory, for the reason
// ReportsSinceBy gives: reconnecting, and restarting the server, must not hand
// somebody a fresh allowance.
func (store *Store) FeedbackItemsSinceBy(
	ctx context.Context,
	authorUserID string,
	sinceUnixMs int64,
) (int, error) {
	var count int
	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM feedback_items
WHERE author_user_id = ? AND created_at_unix_ms >= ?
`, authorUserID, sinceUnixMs).Scan(&count); err != nil {
		return 0, fmt.Errorf("count recent feedback: %w", err)
	}
	return count, nil
}

// FeedbackCommentsSinceBy is the same count for replies, which are rate limited
// separately and more generously: a conversation is several messages and a
// board is one post.
func (store *Store) FeedbackCommentsSinceBy(
	ctx context.Context,
	authorUserID string,
	sinceUnixMs int64,
) (int, error) {
	var count int
	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM feedback_comments
WHERE author_user_id = ? AND created_at_unix_ms >= ?
`, authorUserID, sinceUnixMs).Scan(&count); err != nil {
		return 0, fmt.Errorf("count recent feedback comments: %w", err)
	}
	return count, nil
}

/* ------------------------------------------------------------ reading it -- */

// feedbackSelect is the one column list every read of an item uses, so a column
// added here reaches the list, the single item, and the admin's view together.
//
// The three derived columns are the reason this is a string rather than a
// table name: the tally, the reply count and the viewer's own mark are what the
// board is *for*, and computing them in the query is what keeps them from being
// three stored numbers that can disagree with the rows they count.
const feedbackSelect = `
SELECT i.item_id, i.kind, i.title, i.body, i.author_user_id, i.author_name,
       i.from_host, i.status, i.status_note, i.link_url, i.game_id,
       i.app_version, i.platform, i.duplicate_of, i.pinned, i.hidden,
       i.created_at_unix_ms, i.updated_at_unix_ms,
       (SELECT COUNT(*) FROM feedback_votes v WHERE v.item_id = i.item_id),
       (SELECT COUNT(*) FROM feedback_comments c
         WHERE c.item_id = i.item_id AND c.hidden = 0),
       EXISTS(SELECT 1 FROM feedback_votes v
               WHERE v.item_id = i.item_id AND v.user_id = ?1)
  FROM feedback_items i
`

func scanFeedbackItem(scan func(...any) error) (FeedbackItem, error) {
	var item FeedbackItem
	var kind, status string
	var pinned, hidden, fromHost, voted int
	if err := scan(
		&item.ItemID, &kind, &item.Title, &item.Body, &item.AuthorUserID,
		&item.AuthorName, &fromHost, &status, &item.StatusNote, &item.LinkURL,
		&item.GameID, &item.AppVersion, &item.Platform, &item.DuplicateOf,
		&pinned, &hidden, &item.CreatedAtUnixMs, &item.UpdatedAtUnixMs,
		&item.Votes, &item.Comments, &voted,
	); err != nil {
		return FeedbackItem{}, err
	}
	item.Kind = FeedbackKind(kind)
	item.Status = FeedbackStatus(status)
	item.StatusLabel = StatusLabel(item.Kind, item.Status)
	item.FromHost = fromHost != 0
	item.Pinned = pinned != 0
	item.Hidden = hidden != 0
	item.YouVoted = voted != 0
	return item, nil
}

// feedbackWhere builds the filter's conditions and the arguments they take.
//
// Returned as a pair rather than interpolated, so that the count query and the
// page query are provably asking the same question — a board whose "showing 20
// of 84" disagrees with its own list is a bug that only appears once there is
// enough on the board to page.
func feedbackWhere(filter FeedbackFilter) (string, []any) {
	conditions := []string{}
	arguments := []any{}
	if !filter.IncludeHidden {
		conditions = append(conditions, "i.hidden = 0")
	}
	if filter.Kind != "" {
		conditions = append(conditions, "i.kind = ?")
		arguments = append(arguments, string(filter.Kind))
	}
	if filter.Status != "" {
		conditions = append(conditions, "i.status = ?")
		arguments = append(arguments, string(filter.Status))
	}
	if search := strings.TrimSpace(filter.Search); search != "" {
		// Escaped, because a search for "100%" must not become a search for
		// everything. The ESCAPE clause is what makes the backslashes below
		// mean a literal character rather than a wildcard.
		escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(search)
		conditions = append(
			conditions,
			`(i.title LIKE ? ESCAPE '\' OR i.body LIKE ? ESCAPE '\')`,
		)
		arguments = append(arguments, "%"+escaped+"%", "%"+escaped+"%")
	}
	if len(conditions) == 0 {
		return "", arguments
	}
	return " WHERE " + strings.Join(conditions, " AND "), arguments
}

// feedbackOrder is the board's order.
//
// Pinned first in both, because that is what pinning means. Then, for the
// default sort, anything the host has settled drops below everything live: a
// bug fixed in March with forty votes is not the most important thing on the
// board, and sorting purely by tally is how a board turns into a museum.
// Both end on `i.rowid DESC`, which is what makes the order *total*.
//
// Not a nicety. Two posts can share a millisecond, and every item on a quiet
// board shares a vote count, so without a final tiebreaker the two queries
// behind one page — the count and the rows — are free to break a tie
// differently. That is how an item appears on page one and page two, or on
// neither. The rowid is the only column here that is unique and monotonic, and
// descending it means "most recently inserted", which is the same thing the
// sort above is already trying to say.
func feedbackOrder(sort FeedbackSort) string {
	if sort == FeedbackNewest {
		return " ORDER BY i.pinned DESC, i.created_at_unix_ms DESC, i.rowid DESC"
	}
	return ` ORDER BY i.pinned DESC,
         (i.status IN ('done', 'declined', 'duplicate')) ASC,
         (SELECT COUNT(*) FROM feedback_votes v WHERE v.item_id = i.item_id) DESC,
         i.created_at_unix_ms DESC,
         i.rowid DESC`
}

// FeedbackItems is the board.
func (store *Store) FeedbackItems(
	ctx context.Context,
	filter FeedbackFilter,
) (FeedbackPage, error) {
	limit := filter.Limit
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	offset := max(filter.Offset, 0)

	where, arguments := feedbackWhere(filter)
	page := FeedbackPage{Items: []FeedbackItem{}}
	if err := store.db.QueryRowContext(
		ctx, "SELECT COUNT(*) FROM feedback_items i"+where, arguments...,
	).Scan(&page.Total); err != nil {
		return FeedbackPage{}, fmt.Errorf("count feedback: %w", err)
	}

	// The viewer is ?1 and the filter's arguments follow it, which is why the
	// two lists are concatenated in this order rather than the other.
	query := feedbackSelect + where + feedbackOrder(filter.Sort) + " LIMIT ? OFFSET ?"
	rows, err := store.db.QueryContext(
		ctx,
		query,
		append(append([]any{filter.ViewerUserID}, arguments...), limit, offset)...,
	)
	if err != nil {
		return FeedbackPage{}, fmt.Errorf("read feedback: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		item, err := scanFeedbackItem(rows.Scan)
		if err != nil {
			return FeedbackPage{}, fmt.Errorf("read feedback: %w", err)
		}
		page.Items = append(page.Items, item)
	}
	if err := rows.Err(); err != nil {
		return FeedbackPage{}, fmt.Errorf("read feedback: %w", err)
	}

	if err := store.db.QueryRowContext(ctx, `
SELECT
    COUNT(*) FILTER (WHERE kind = 'bug'),
    COUNT(*) FILTER (WHERE kind = 'suggestion')
  FROM feedback_items
 WHERE hidden = 0 AND status IN ('open', 'accepted')
`).Scan(&page.OpenBugs, &page.OpenSuggestions); err != nil {
		return FeedbackPage{}, fmt.Errorf("count open feedback: %w", err)
	}
	return page, nil
}

// FeedbackItemByID is one item with its replies.
//
// The thread comes back on the same call rather than from a second route
// because an item without its discussion is half an answer, and a board where
// opening a bug costs two round trips is one that feels slow on a phone.
func (store *Store) FeedbackItemByID(
	ctx context.Context,
	itemID string,
	viewerUserID string,
	includeHidden bool,
) (FeedbackItem, error) {
	item, err := scanFeedbackItem(store.db.QueryRowContext(
		ctx, feedbackSelect+" WHERE i.item_id = ?2", viewerUserID, itemID,
	).Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return FeedbackItem{}, ErrFeedbackNotFound
	}
	if err != nil {
		return FeedbackItem{}, fmt.Errorf("read feedback item: %w", err)
	}
	if item.Hidden && !includeHidden {
		// Not found rather than forbidden: a hidden item is one the host has
		// taken off the board, and confirming that a particular id exists but
		// is being withheld is an invitation to go looking for it.
		return FeedbackItem{}, ErrFeedbackNotFound
	}
	thread, err := store.FeedbackComments(ctx, itemID, includeHidden)
	if err != nil {
		return FeedbackItem{}, err
	}
	item.Thread = thread
	return item, nil
}

/* ------------------------------------------------------------- the votes -- */

// SetFeedbackVote casts or withdraws one account's vote, and answers with the
// tally as it stands after.
//
// Idempotent in both directions: voting twice is one vote, and withdrawing a
// vote nobody cast is not an error. A button that can be double-tapped on a
// phone with a slow connection has to be, and the alternative is an error
// message for something the player meant and already got.
func (store *Store) SetFeedbackVote(
	ctx context.Context,
	itemID string,
	userID string,
	voted bool,
) (int, error) {
	if strings.TrimSpace(userID) == "" {
		return 0, ErrAccountNotFound
	}
	var hidden int
	err := store.db.QueryRowContext(ctx,
		"SELECT hidden FROM feedback_items WHERE item_id = ?", itemID,
	).Scan(&hidden)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrFeedbackNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("vote on feedback: %w", err)
	}
	if hidden != 0 {
		return 0, ErrFeedbackNotFound
	}

	if voted {
		if _, err := store.db.ExecContext(ctx, `
INSERT OR IGNORE INTO feedback_votes (item_id, user_id, created_at_unix_ms)
VALUES (?, ?, ?)
`, itemID, userID, time.Now().UnixMilli()); err != nil {
			return 0, fmt.Errorf("vote on feedback: %w", err)
		}
	} else if _, err := store.db.ExecContext(ctx,
		"DELETE FROM feedback_votes WHERE item_id = ? AND user_id = ?", itemID, userID,
	); err != nil {
		return 0, fmt.Errorf("withdraw feedback vote: %w", err)
	}

	var votes int
	if err := store.db.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM feedback_votes WHERE item_id = ?", itemID,
	).Scan(&votes); err != nil {
		return 0, fmt.Errorf("count feedback votes: %w", err)
	}
	return votes, nil
}

/* ---------------------------------------------------------- the replies -- */

// AddFeedbackComment replies to an item.
func (store *Store) AddFeedbackComment(
	ctx context.Context,
	input NewFeedbackComment,
) (FeedbackComment, error) {
	body := truncateRunes(strings.TrimSpace(input.Body), MaximumFeedbackCommentRunes)
	if body == "" {
		return FeedbackComment{}, ErrFeedbackNeedsText
	}
	var hidden int
	err := store.db.QueryRowContext(ctx,
		"SELECT hidden FROM feedback_items WHERE item_id = ?", input.ItemID,
	).Scan(&hidden)
	if errors.Is(err, sql.ErrNoRows) {
		return FeedbackComment{}, ErrFeedbackNotFound
	}
	if err != nil {
		return FeedbackComment{}, fmt.Errorf("comment on feedback: %w", err)
	}
	if hidden != 0 {
		return FeedbackComment{}, ErrFeedbackNotFound
	}

	commentID, err := randomToken(9)
	if err != nil {
		return FeedbackComment{}, fmt.Errorf("comment on feedback: %w", err)
	}
	now := time.Now().UnixMilli()
	comment := FeedbackComment{
		CommentID:       commentID,
		ItemID:          input.ItemID,
		AuthorUserID:    strings.TrimSpace(input.AuthorUserID),
		AuthorName:      strings.TrimSpace(input.AuthorName),
		FromHost:        input.FromHost,
		Body:            body,
		CreatedAtUnixMs: now,
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO feedback_comments (
    comment_id, item_id, author_user_id, author_name, from_host, body,
    hidden, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, 0, ?)
`,
		comment.CommentID, comment.ItemID, comment.AuthorUserID,
		comment.AuthorName, boolToInt(comment.FromHost), comment.Body, now,
	); err != nil {
		return FeedbackComment{}, fmt.Errorf("comment on feedback: %w", err)
	}

	// A reply is activity, and the board's "last touched" should say so. The
	// item's own text is unchanged; what moved is the conversation on it.
	if _, err := store.db.ExecContext(ctx,
		"UPDATE feedback_items SET updated_at_unix_ms = ? WHERE item_id = ?", now, input.ItemID,
	); err != nil {
		return FeedbackComment{}, fmt.Errorf("comment on feedback: touch item: %w", err)
	}
	return comment, nil
}

// FeedbackComments is one item's thread, oldest first, which is the order a
// conversation is read in.
func (store *Store) FeedbackComments(
	ctx context.Context,
	itemID string,
	includeHidden bool,
) ([]FeedbackComment, error) {
	query := `
SELECT comment_id, item_id, author_user_id, author_name, from_host, body,
       hidden, created_at_unix_ms
  FROM feedback_comments
 WHERE item_id = ?`
	if !includeHidden {
		query += " AND hidden = 0"
	}
	query += " ORDER BY created_at_unix_ms ASC"

	rows, err := store.db.QueryContext(ctx, query, itemID)
	if err != nil {
		return nil, fmt.Errorf("read feedback thread: %w", err)
	}
	defer rows.Close()
	comments := []FeedbackComment{}
	for rows.Next() {
		var comment FeedbackComment
		var fromHost, hidden int
		if err := rows.Scan(
			&comment.CommentID, &comment.ItemID, &comment.AuthorUserID,
			&comment.AuthorName, &fromHost, &comment.Body, &hidden,
			&comment.CreatedAtUnixMs,
		); err != nil {
			return nil, fmt.Errorf("read feedback thread: %w", err)
		}
		comment.FromHost = fromHost != 0
		comment.Hidden = hidden != 0
		comments = append(comments, comment)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("read feedback thread: %w", err)
	}
	return comments, nil
}

// FeedbackCommentByID is one reply, for the routes that have to ask who wrote
// it before deciding whether the caller may remove it.
func (store *Store) FeedbackCommentByID(
	ctx context.Context,
	commentID string,
) (FeedbackComment, error) {
	var comment FeedbackComment
	var fromHost, hidden int
	err := store.db.QueryRowContext(ctx, `
SELECT comment_id, item_id, author_user_id, author_name, from_host, body,
       hidden, created_at_unix_ms
  FROM feedback_comments WHERE comment_id = ?
`, commentID).Scan(
		&comment.CommentID, &comment.ItemID, &comment.AuthorUserID,
		&comment.AuthorName, &fromHost, &comment.Body, &hidden,
		&comment.CreatedAtUnixMs,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return FeedbackComment{}, ErrFeedbackCommentNotFound
	}
	if err != nil {
		return FeedbackComment{}, fmt.Errorf("read feedback comment: %w", err)
	}
	comment.FromHost = fromHost != 0
	comment.Hidden = hidden != 0
	return comment, nil
}

// DeleteFeedbackComment removes one reply.
func (store *Store) DeleteFeedbackComment(ctx context.Context, commentID string) error {
	result, err := store.db.ExecContext(ctx,
		"DELETE FROM feedback_comments WHERE comment_id = ?", commentID)
	if err != nil {
		return fmt.Errorf("delete feedback comment: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return ErrFeedbackCommentNotFound
	}
	return nil
}

// HideFeedbackComment takes one reply off the thread without deleting it, which
// is what the host reaches for when the account behind it still has to be dealt
// with. See the note on FeedbackItem.Hidden.
func (store *Store) HideFeedbackComment(
	ctx context.Context,
	commentID string,
	hidden bool,
) (FeedbackComment, error) {
	result, err := store.db.ExecContext(ctx,
		"UPDATE feedback_comments SET hidden = ? WHERE comment_id = ?",
		boolToInt(hidden), commentID)
	if err != nil {
		return FeedbackComment{}, fmt.Errorf("hide feedback comment: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return FeedbackComment{}, ErrFeedbackCommentNotFound
	}
	return store.FeedbackCommentByID(ctx, commentID)
}

/* ------------------------------------------------------- the host's pass -- */

// UpdateFeedbackItem applies the host's edit and answers with the item as it
// now stands.
func (store *Store) UpdateFeedbackItem(
	ctx context.Context,
	itemID string,
	edit FeedbackEdit,
	viewerUserID string,
) (FeedbackItem, error) {
	current, err := store.FeedbackItemByID(ctx, itemID, viewerUserID, true)
	if err != nil {
		return FeedbackItem{}, err
	}

	assignments := []string{}
	arguments := []any{}
	if edit.Kind != nil {
		if !edit.Kind.Valid() {
			return FeedbackItem{}, fmt.Errorf("%w: %q", ErrUnknownFeedbackKind, *edit.Kind)
		}
		assignments = append(assignments, "kind = ?")
		arguments = append(arguments, string(*edit.Kind))
	}
	if edit.Status != nil {
		if !edit.Status.Valid() {
			return FeedbackItem{}, fmt.Errorf("%w: %q", ErrUnknownFeedbackStatus, *edit.Status)
		}
		assignments = append(assignments, "status = ?")
		arguments = append(arguments, string(*edit.Status))
	}
	if edit.StatusNote != nil {
		assignments = append(assignments, "status_note = ?")
		arguments = append(
			arguments,
			truncateRunes(strings.TrimSpace(*edit.StatusNote), MaximumFeedbackNoteRunes),
		)
	}
	if edit.LinkURL != nil {
		link, err := normalizeFeedbackLink(*edit.LinkURL)
		if err != nil {
			return FeedbackItem{}, err
		}
		assignments = append(assignments, "link_url = ?")
		arguments = append(arguments, link)
	}
	if edit.Title != nil {
		title := truncateRunes(strings.TrimSpace(*edit.Title), MaximumFeedbackTitleRunes)
		if title == "" {
			return FeedbackItem{}, ErrFeedbackNeedsTitle
		}
		assignments = append(assignments, "title = ?")
		arguments = append(arguments, title)
	}
	if edit.DuplicateOf != nil {
		duplicate := strings.TrimSpace(*edit.DuplicateOf)
		if duplicate == itemID {
			return FeedbackItem{}, ErrFeedbackDuplicateOfItself
		}
		// Checked rather than trusted, because this id becomes a link on
		// everybody's screen and a wrong one is a dead end that looks like the
		// host's answer. Clearing it is always allowed.
		if duplicate != "" {
			var exists int
			if err := store.db.QueryRowContext(ctx,
				"SELECT COUNT(*) FROM feedback_items WHERE item_id = ?", duplicate,
			).Scan(&exists); err != nil {
				return FeedbackItem{}, fmt.Errorf("update feedback: %w", err)
			}
			if exists == 0 {
				return FeedbackItem{}, ErrFeedbackNotFound
			}
		}
		assignments = append(assignments, "duplicate_of = ?")
		arguments = append(arguments, duplicate)
	}
	if edit.Pinned != nil {
		assignments = append(assignments, "pinned = ?")
		arguments = append(arguments, boolToInt(*edit.Pinned))
	}
	if edit.Hidden != nil {
		assignments = append(assignments, "hidden = ?")
		arguments = append(arguments, boolToInt(*edit.Hidden))
	}
	if len(assignments) == 0 {
		return current, nil
	}

	assignments = append(assignments, "updated_at_unix_ms = ?")
	arguments = append(arguments, time.Now().UnixMilli(), itemID)
	if _, err := store.db.ExecContext(ctx,
		"UPDATE feedback_items SET "+strings.Join(assignments, ", ")+" WHERE item_id = ?",
		arguments...,
	); err != nil {
		return FeedbackItem{}, fmt.Errorf("update feedback: %w", err)
	}
	return store.FeedbackItemByID(ctx, itemID, viewerUserID, true)
}

// DeleteFeedbackItem removes a post, its votes and its thread.
//
// One transaction, because a half-deleted item is a tally counting votes for
// something that is not there. The host reaches for Hidden more often than for
// this; see the note on FeedbackItem.Hidden.
func (store *Store) DeleteFeedbackItem(ctx context.Context, itemID string) error {
	transaction, err := store.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("delete feedback: %w", err)
	}
	defer func() { _ = transaction.Rollback() }()

	result, err := transaction.ExecContext(ctx,
		"DELETE FROM feedback_items WHERE item_id = ?", itemID)
	if err != nil {
		return fmt.Errorf("delete feedback: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return ErrFeedbackNotFound
	}
	if _, err := transaction.ExecContext(ctx,
		"DELETE FROM feedback_votes WHERE item_id = ?", itemID); err != nil {
		return fmt.Errorf("delete feedback: votes: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		"DELETE FROM feedback_comments WHERE item_id = ?", itemID); err != nil {
		return fmt.Errorf("delete feedback: thread: %w", err)
	}
	// An item that pointed at this one as its duplicate now points nowhere, so
	// the pointer goes rather than being left to render as a link to a missing
	// page. The status stays: it was a duplicate, and still is.
	if _, err := transaction.ExecContext(ctx,
		"UPDATE feedback_items SET duplicate_of = '' WHERE duplicate_of = ?", itemID,
	); err != nil {
		return fmt.Errorf("delete feedback: duplicates: %w", err)
	}
	if err := transaction.Commit(); err != nil {
		return fmt.Errorf("delete feedback: %w", err)
	}
	return nil
}

// AnonymizeFeedbackAuthorship is what a deleted account leaves behind here.
//
// The posts and the replies stay, with the name replaced exactly as a game
// record's is — the privacy policy's reasoning about a shared game applies at
// least as strongly to a conversation, where removing one side leaves replies
// answering nobody. What does go is the votes: a tally is a count of people who
// want something, and somebody who has left the site is not one of them.
//
// The author id is cleared along with the name. It is what the delete button on
// a post is checked against, and an id that could be issued again must not come
// with authority over a stranger's posts.
func AnonymizeFeedbackAuthorshipTx(
	ctx context.Context,
	transaction *sql.Tx,
	userID string,
	anonymousName string,
) error {
	if _, err := transaction.ExecContext(ctx, `
UPDATE feedback_items SET author_user_id = '', author_name = ?
 WHERE author_user_id = ?
`, anonymousName, userID); err != nil {
		return fmt.Errorf("anonymize feedback: items: %w", err)
	}
	if _, err := transaction.ExecContext(ctx, `
UPDATE feedback_comments SET author_user_id = '', author_name = ?
 WHERE author_user_id = ?
`, anonymousName, userID); err != nil {
		return fmt.Errorf("anonymize feedback: thread: %w", err)
	}
	if _, err := transaction.ExecContext(ctx,
		"DELETE FROM feedback_votes WHERE user_id = ?", userID,
	); err != nil {
		return fmt.Errorf("anonymize feedback: votes: %w", err)
	}
	return nil
}
