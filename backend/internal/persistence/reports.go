package persistence

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
)

// A player telling the host that somebody needs looking at.
//
// The three moderation files answer three different questions and it is worth
// being clear which is which:
//
//   - moderation.go is the host acting: a mute, a ranked bar, an event bar.
//   - blocks.go is one player's own preference, which nobody else ever sees.
//   - this file is the path between them. A report changes nothing by itself.
//     It is a message with enough context attached that the host can decide,
//     later, whether one of the sanctions applies.
//
// # Why the context is copied, not referenced
//
// A report stores the *text* of what was reported, not a pointer to it. Chat
// here lives in server memory for the length of a game and is never written to
// the database (see the privacy policy, which says so), so a report that named
// a message id would be a report about something that no longer exists by the
// time anybody reads it. The same goes for the reported player's name: they can
// change it, and a report that read "player 4f2a said something" is one nobody
// can act on.
//
// So the row is a snapshot. It is larger than a reference and it is the only
// version that still means anything in a week.
//
// # Who may file one
//
// Anybody who can play, which on this site includes guests: every browser owns
// an account whether or not it has ever signed in, and the player most likely
// to meet something they want to report is the one who arrived five minutes
// ago. Requiring a sign-in first would leave the report button working only for
// the people least likely to need it. Rate limiting is what stands in place of
// the account requirement — see ReportsSinceBy.

// ReportCategory is what the reporter says the problem is.
//
// A closed list rather than free text, because the category is what the host
// sorts the queue by and "harassment" spelled fourteen ways sorts into
// fourteen piles. The reporter's own words go in Details, which is where the
// specifics belong.
type ReportCategory string

const (
	// ReportHarassment covers threats, abuse, and following somebody around.
	ReportHarassment ReportCategory = "harassment"
	// ReportHate covers slurs and bigotry, which is worth separating from
	// harassment because it is judged differently and acted on faster.
	ReportHate ReportCategory = "hate"
	// ReportSexual covers sexual content aimed at somebody who did not ask,
	// and anything involving a minor.
	ReportSexual ReportCategory = "sexual"
	// ReportSpam covers advertising, link-dropping, and flooding a room.
	ReportSpam ReportCategory = "spam"
	// ReportCheating covers engine use, sandbagging, and rigging results —
	// the one category that is about the game rather than about conduct.
	ReportCheating ReportCategory = "cheating"
	// ReportName covers an offensive username or Discord handle, which is
	// reported without any message existing to point at.
	ReportName ReportCategory = "name"
	// ReportOther is the escape hatch. It exists so that something the list
	// does not cover gets reported at all rather than filed under the nearest
	// wrong heading.
	ReportOther ReportCategory = "other"
)

// ReportCategories is every category there is, in the order the report form
// offers them: most serious first, "other" last.
var ReportCategories = []ReportCategory{
	ReportHarassment,
	ReportHate,
	ReportSexual,
	ReportSpam,
	ReportCheating,
	ReportName,
	ReportOther,
}

// Valid reports whether this is one of the categories above.
func (category ReportCategory) Valid() bool {
	for _, known := range ReportCategories {
		if category == known {
			return true
		}
	}
	return false
}

// Label is the category in the words the report form and the admin queue show.
func (category ReportCategory) Label() string {
	switch category {
	case ReportHarassment:
		return "Harassment or threats"
	case ReportHate:
		return "Hate speech or slurs"
	case ReportSexual:
		return "Sexual content"
	case ReportSpam:
		return "Spam or advertising"
	case ReportCheating:
		return "Cheating"
	case ReportName:
		return "Offensive username"
	case ReportOther:
		return "Something else"
	}
	return string(category)
}

// ReportStatus is where a report has got to.
type ReportStatus string

const (
	// ReportOpen is one nobody has looked at yet.
	ReportOpen ReportStatus = "open"
	// ReportActioned is one the host agreed with and did something about.
	ReportActioned ReportStatus = "actioned"
	// ReportDismissed is one the host looked at and decided needed nothing.
	// Not the same as ignoring it: a dismissed report has been read.
	ReportDismissed ReportStatus = "dismissed"
)

// Valid reports whether this is one of the three states.
func (status ReportStatus) Valid() bool {
	switch status {
	case ReportOpen, ReportActioned, ReportDismissed:
		return true
	}
	return false
}

// ErrUnknownReportCategory and ErrReportNotFound are what a bad category and a
// bad id produce, rather than a row nothing will ever read.
var (
	ErrUnknownReportCategory = errors.New("unknown report category")
	ErrUnknownReportStatus   = errors.New("unknown report status")
	ErrReportNotFound        = errors.New("report not found")
	ErrCannotReportSelf      = errors.New("you cannot report yourself")
	// ErrReportNeedsTarget and ErrReportNeedsDetails are the two ways a report
	// arrives with nothing in it that anybody could act on. Sentinels rather
	// than plain errors so the route can answer 400 rather than 500: they are
	// both the caller's mistake, and a report form that reports a server fault
	// for a missing field is one people give up on.
	ErrReportNeedsTarget  = errors.New("say who this report is about")
	ErrReportNeedsDetails = errors.New("say what the problem is")
)

const (
	// MaximumReportDetailRunes bounds what the reporter types. Long enough for
	// somebody to explain a situation, short enough that the field is not a
	// place to paste a novel into the database.
	MaximumReportDetailRunes = 1000
	// MaximumReportContextRunes bounds the copied evidence. A chat room holds
	// at most a couple of hundred messages and only the recent ones matter, so
	// this is generous for the handful a reporter attaches.
	MaximumReportContextRunes = 4000
)

// Report is one filed report, as stored and as the admin queue shows it.
type Report struct {
	ReportID string `json:"reportId"`
	// ReporterUserID and ReporterName: the id so the host can reach them, and
	// the name they were wearing at the time so the queue reads without a
	// join. A report is never shown to the person it is about, so neither is
	// published anywhere but the admin screen.
	ReporterUserID string `json:"reporterUserId"`
	ReporterName   string `json:"reporterName"`
	// TargetUserID is empty for a report about somebody the reporter could not
	// name — a message from an account that has since gone. The name is what
	// is always there.
	TargetUserID string         `json:"targetUserId,omitempty"`
	TargetName   string         `json:"targetName"`
	Category     ReportCategory `json:"category"`
	Details      string         `json:"details,omitempty"`
	// GameID is where it happened, when it happened in a game. The host can
	// open the board and read the moves; the chat is not there to be read, so
	// Context carries it instead.
	GameID string `json:"gameId,omitempty"`
	// Context is the copied evidence: the chat lines around the incident, as
	// the reporter's client had them. See the note at the top of this file
	// about why this is a snapshot rather than a reference.
	Context           string       `json:"context,omitempty"`
	Status            ReportStatus `json:"status"`
	CreatedAtUnixMs   int64        `json:"createdAtUnixMs"`
	ResolvedAtUnixMs  *int64       `json:"resolvedAtUnixMs,omitempty"`
	ResolvedByUserID  string       `json:"resolvedByUserId,omitempty"`
	ResolutionNote    string       `json:"resolutionNote,omitempty"`
	TargetIsDisabled  bool         `json:"targetIsDisabled,omitempty"`
	TargetOpenReports int          `json:"targetOpenReports,omitempty"`
}

// NewReport is a report about to be filed.
type NewReport struct {
	ReporterUserID string
	ReporterName   string
	TargetUserID   string
	TargetName     string
	Category       ReportCategory
	Details        string
	GameID         string
	Context        string
}

// ReportFilter narrows the admin queue.
type ReportFilter struct {
	// Status is which pile to show, and empty means all of them. The admin
	// screen opens on `open`, which is the queue; everything else is history.
	Status ReportStatus
	Limit  int
	Offset int
}

// ReportPage is one screen of the queue, plus how many there are in total so
// the client can page without guessing.
type ReportPage struct {
	Reports []Report `json:"reports"`
	Total   int      `json:"total"`
	// Open is how many are unread across every filter, which is the number the
	// admin screen puts on the tab. It does not change with the filter — the
	// point of it is to be visible while looking at something else.
	Open int `json:"open"`
}

// ensureReportSchema creates the report queue.
//
// No foreign key on either party. Both are deliberate: a report about an
// account that is later purged is exactly the report a host still wants to
// read, and cascading it away would delete the evidence along with the
// evidence's subject.
func (store *Store) ensureReportSchema(ctx context.Context) error {
	const schema = `
CREATE TABLE IF NOT EXISTS content_reports (
    report_id TEXT PRIMARY KEY,
    reporter_user_id TEXT NOT NULL,
    reporter_name TEXT NOT NULL DEFAULT '',
    target_user_id TEXT NOT NULL DEFAULT '',
    target_name TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL,
    details TEXT NOT NULL DEFAULT '',
    game_id TEXT NOT NULL DEFAULT '',
    context TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'open'
        CHECK (status IN ('open', 'actioned', 'dismissed')),
    created_at_unix_ms INTEGER NOT NULL,
    resolved_at_unix_ms INTEGER,
    resolved_by_user_id TEXT NOT NULL DEFAULT '',
    resolution_note TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS content_reports_status_idx
    ON content_reports(status, created_at_unix_ms DESC);
CREATE INDEX IF NOT EXISTS content_reports_target_idx
    ON content_reports(target_user_id, status);
CREATE INDEX IF NOT EXISTS content_reports_reporter_idx
    ON content_reports(reporter_user_id, created_at_unix_ms DESC);
`
	if _, err := store.db.ExecContext(ctx, schema); err != nil {
		return fmt.Errorf("migrate report schema: %w", err)
	}
	return nil
}

// CreateReport files one.
func (store *Store) CreateReport(ctx context.Context, input NewReport) (Report, error) {
	if !input.Category.Valid() {
		return Report{}, fmt.Errorf("%w: %q", ErrUnknownReportCategory, input.Category)
	}
	input.ReporterUserID = strings.TrimSpace(input.ReporterUserID)
	input.TargetUserID = strings.TrimSpace(input.TargetUserID)
	input.TargetName = strings.TrimSpace(input.TargetName)
	if input.ReporterUserID == "" {
		return Report{}, ErrAccountNotFound
	}
	if input.TargetUserID != "" && input.TargetUserID == input.ReporterUserID {
		return Report{}, ErrCannotReportSelf
	}
	if input.TargetUserID == "" && input.TargetName == "" {
		return Report{}, ErrReportNeedsTarget
	}
	details := truncateRunes(strings.TrimSpace(input.Details), MaximumReportDetailRunes)
	evidence := truncateRunes(strings.TrimSpace(input.Context), MaximumReportContextRunes)
	if input.Category == ReportOther && details == "" {
		return Report{}, ErrReportNeedsDetails
	}

	reportID, err := randomToken(16)
	if err != nil {
		return Report{}, fmt.Errorf("create report: %w", err)
	}
	now := time.Now().UnixMilli()
	report := Report{
		ReportID:        reportID,
		ReporterUserID:  input.ReporterUserID,
		ReporterName:    strings.TrimSpace(input.ReporterName),
		TargetUserID:    input.TargetUserID,
		TargetName:      input.TargetName,
		Category:        input.Category,
		Details:         details,
		GameID:          strings.TrimSpace(input.GameID),
		Context:         evidence,
		Status:          ReportOpen,
		CreatedAtUnixMs: now,
	}
	if _, err := store.db.ExecContext(ctx, `
INSERT INTO content_reports (
    report_id, reporter_user_id, reporter_name, target_user_id, target_name,
    category, details, game_id, context, status, created_at_unix_ms
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)
`,
		report.ReportID, report.ReporterUserID, report.ReporterName,
		report.TargetUserID, report.TargetName, string(report.Category),
		report.Details, report.GameID, report.Context, now,
	); err != nil {
		return Report{}, fmt.Errorf("create report: %w", err)
	}
	return report, nil
}

// ReportsSinceBy counts what one reporter has filed lately, which is what the
// rate limit is spent against.
//
// Per account rather than per connection, because the abuse this guards
// against — filing the same report a hundred times, or reporting somebody
// repeatedly out of spite — is not stopped by asking them to reconnect.
func (store *Store) ReportsSinceBy(
	ctx context.Context,
	reporterUserID string,
	sinceUnixMs int64,
) (int, error) {
	var count int
	if err := store.db.QueryRowContext(ctx, `
SELECT COUNT(*) FROM content_reports
WHERE reporter_user_id = ? AND created_at_unix_ms >= ?
`, strings.TrimSpace(reporterUserID), sinceUnixMs).Scan(&count); err != nil {
		return 0, fmt.Errorf("count recent reports: %w", err)
	}
	return count, nil
}

// Reports is the admin queue.
func (store *Store) Reports(ctx context.Context, filter ReportFilter) (ReportPage, error) {
	if filter.Status != "" && !filter.Status.Valid() {
		return ReportPage{}, fmt.Errorf("%w: %q", ErrUnknownReportStatus, filter.Status)
	}
	if filter.Limit <= 0 || filter.Limit > 200 {
		filter.Limit = 50
	}
	if filter.Offset < 0 {
		filter.Offset = 0
	}
	where, arguments := "", []any(nil)
	if filter.Status != "" {
		where = "WHERE status = ?"
		arguments = append(arguments, string(filter.Status))
	}

	var page ReportPage
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM content_reports `+where, arguments...,
	).Scan(&page.Total); err != nil {
		return ReportPage{}, fmt.Errorf("count reports: %w", err)
	}
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM content_reports WHERE status = 'open'`,
	).Scan(&page.Open); err != nil {
		return ReportPage{}, fmt.Errorf("count open reports: %w", err)
	}

	// The two joined columns are what turns a queue into something actionable:
	// whether the account is already disabled, and how many other open reports
	// name it. A third report about the same person is a different decision
	// from a first one.
	rows, err := store.db.QueryContext(ctx, `
SELECT r.report_id, r.reporter_user_id, r.reporter_name, r.target_user_id,
       r.target_name, r.category, r.details, r.game_id, r.context, r.status,
       r.created_at_unix_ms, r.resolved_at_unix_ms, r.resolved_by_user_id,
       r.resolution_note,
       COALESCE((SELECT a.disabled FROM accounts a WHERE a.user_id = r.target_user_id), 0),
       (SELECT COUNT(*) FROM content_reports o
         WHERE o.target_user_id <> '' AND o.target_user_id = r.target_user_id
           AND o.status = 'open')
FROM content_reports r
`+where+`
ORDER BY r.created_at_unix_ms DESC
LIMIT ? OFFSET ?
`, append(append([]any(nil), arguments...), filter.Limit, filter.Offset)...)
	if err != nil {
		return ReportPage{}, fmt.Errorf("list reports: %w", err)
	}
	defer func() { _ = rows.Close() }()

	page.Reports = make([]Report, 0, filter.Limit)
	for rows.Next() {
		var report Report
		var resolvedAt sql.NullInt64
		var disabled int
		if err := rows.Scan(
			&report.ReportID, &report.ReporterUserID, &report.ReporterName,
			&report.TargetUserID, &report.TargetName, &report.Category,
			&report.Details, &report.GameID, &report.Context, &report.Status,
			&report.CreatedAtUnixMs, &resolvedAt, &report.ResolvedByUserID,
			&report.ResolutionNote, &disabled, &report.TargetOpenReports,
		); err != nil {
			return ReportPage{}, fmt.Errorf("list reports: %w", err)
		}
		if resolvedAt.Valid {
			moment := resolvedAt.Int64
			report.ResolvedAtUnixMs = &moment
		}
		report.TargetIsDisabled = disabled == 1
		page.Reports = append(page.Reports, report)
	}
	if err := rows.Err(); err != nil {
		return ReportPage{}, fmt.Errorf("list reports: %w", err)
	}
	return page, nil
}

// ResolveReport records that somebody looked at one.
//
// Re-resolving is allowed and overwrites: a report dismissed by mistake is
// corrected by resolving it again, and there is still exactly one answer
// against it. Setting it back to `open` clears the resolution, which is what
// reopening means.
func (store *Store) ResolveReport(
	ctx context.Context,
	reportID string,
	status ReportStatus,
	resolvedBy string,
	note string,
) (Report, error) {
	if !status.Valid() {
		return Report{}, fmt.Errorf("%w: %q", ErrUnknownReportStatus, status)
	}
	reportID = strings.TrimSpace(reportID)
	note = truncateRunes(strings.TrimSpace(note), MaximumReportDetailRunes)

	var resolvedAt any
	if status != ReportOpen {
		resolvedAt = time.Now().UnixMilli()
		// A reopened report keeps no stale resolver or note; a resolved one
		// records both.
	} else {
		resolvedBy, note = "", ""
	}
	result, err := store.db.ExecContext(ctx, `
UPDATE content_reports
SET status = ?, resolved_at_unix_ms = ?, resolved_by_user_id = ?, resolution_note = ?
WHERE report_id = ?
`, string(status), resolvedAt, strings.TrimSpace(resolvedBy), note, reportID)
	if err != nil {
		return Report{}, fmt.Errorf("resolve report: %w", err)
	}
	if affected, _ := result.RowsAffected(); affected == 0 {
		return Report{}, ErrReportNotFound
	}
	return store.Report(ctx, reportID)
}

// Report reads one back.
func (store *Store) Report(ctx context.Context, reportID string) (Report, error) {
	var report Report
	var resolvedAt sql.NullInt64
	err := store.db.QueryRowContext(ctx, `
SELECT report_id, reporter_user_id, reporter_name, target_user_id, target_name,
       category, details, game_id, context, status, created_at_unix_ms,
       resolved_at_unix_ms, resolved_by_user_id, resolution_note
FROM content_reports WHERE report_id = ?
`, strings.TrimSpace(reportID)).Scan(
		&report.ReportID, &report.ReporterUserID, &report.ReporterName,
		&report.TargetUserID, &report.TargetName, &report.Category,
		&report.Details, &report.GameID, &report.Context, &report.Status,
		&report.CreatedAtUnixMs, &resolvedAt, &report.ResolvedByUserID,
		&report.ResolutionNote,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return Report{}, ErrReportNotFound
	}
	if err != nil {
		return Report{}, fmt.Errorf("read report: %w", err)
	}
	if resolvedAt.Valid {
		moment := resolvedAt.Int64
		report.ResolvedAtUnixMs = &moment
	}
	return report, nil
}

// OpenReportCount is how many are waiting, for the badge on the admin tab.
func (store *Store) OpenReportCount(ctx context.Context) (int, error) {
	var count int
	if err := store.db.QueryRowContext(ctx,
		`SELECT COUNT(*) FROM content_reports WHERE status = 'open'`,
	).Scan(&count); err != nil {
		return 0, fmt.Errorf("count open reports: %w", err)
	}
	return count, nil
}

// truncateRunes cuts a string to a rune count, rather than a byte count that
// would split a multi-byte character in half.
func truncateRunes(value string, limit int) string {
	runes := []rune(value)
	if len(runes) <= limit {
		return value
	}
	return string(runes[:limit])
}
