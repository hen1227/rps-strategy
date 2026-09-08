package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
	"rps-strategy/backend/internal/game"
	"rps-strategy/backend/internal/persistence"
)

type GameSession struct {
	gameID     string
	modeID     game.ModeID
	game       *game.Game
	redClient  *Client
	blueClient *Client
	redElo     int
	blueElo    int
	spectators map[*Client]struct{}
	// chat is the conversation this game belongs to. Usually one room per
	// game, but every game of a bot series points at the same one.
	chat               *chatRoom
	redDisconnectedAt  time.Time
	blueDisconnectedAt time.Time
	// redIsEngine and blueIsEngine say whether each seat belongs to a bot,
	// which is the one thing that decides how long an empty seat is held open.
	// Recorded on the session rather than read off the client, because the
	// client is exactly what is missing at the moment the question is asked —
	// an empty seat has no connection to ask, and the account that owns it
	// cannot change hands mid-game. See botReconnectGracePeriod.
	redIsEngine  bool
	blueIsEngine bool
	startedAt    time.Time
	ranked       bool
	tournament   *tournamentMatchRef
	botMatch     *botMatchRef
	// bookPlies and openingSeed describe the dealt opening a series game
	// started from, so the archive can mark which moves nobody chose.
	bookPlies   int
	openingSeed string
	// start is the escrow behind a game that has been opened but not begun: the
	// two seeks it consumed, and the moment it gives up waiting for a first
	// move. Nil for a game that has begun, and for every game that never had
	// this state — a tournament round, a bot series. Read and written only
	// under Server.mu.
	start     *matchStart
	closeOnce sync.Once
}

type CompletedGame struct {
	state     game.GameState
	expiresAt time.Time
}

const (
	reconnectGracePeriod = 30 * time.Second
	// botReconnectGracePeriod is the same window for a seat an engine holds,
	// and it is half the length because the two are waiting on different
	// things. A person is finding their phone, changing trains, reopening a
	// tab they closed by accident — half a minute is barely enough. An engine
	// is a supervised process with a reconnect loop in it: rpsbot.py comes
	// back on a one-second backoff, so a socket that is still gone fifteen
	// seconds later has hit something its owner has to fix, and every second
	// after that is one the opponent spends looking at a board nobody is
	// playing.
	//
	// Whichever comes first, this or the clock: an engine that drops on its
	// own move still flags at zero, and expireGames reads the clock before it
	// reads this, so the record says the game was lost on time rather than
	// abandoned. See reconnectDeadline.
	botReconnectGracePeriod = 15 * time.Second
	completedGameRetention  = 30 * time.Second
	authenticationTimeout   = 10 * time.Second
	maximumChatRunes        = 300
	maximumChatHistory      = 100
	challengeLifetime       = 10 * time.Minute
	maximumPendingPerName   = 10
)

type Participant struct {
	session *GameSession
	color   game.PlayerColor
}

type Server struct {
	hub            *Hub
	seeks          *seekBoard
	registry       *game.ModeRegistry
	data           *persistence.Store
	upgrader       websocket.Upgrader
	originAllowed  func(*http.Request) bool
	adminTokenHash [sha256.Size]byte
	adminEnabled   bool

	mu             sync.RWMutex
	participants   map[*Client]Participant
	games          map[string]*GameSession
	completedGames map[string]CompletedGame
	spectating     map[*Client]*GameSession
	// A finished game leaves the lobby immediately but stays addressable as a
	// chat room, so the people who were in it can keep talking. Its members
	// move out of participants and spectating into postGameMembers, and the
	// room closes as soon as the last of them leaves or disconnects.
	postGameRooms   map[string]*GameSession
	postGameMembers map[*Client]Participant
	// Scheduled tournament matches waiting for both players, then playing out
	// in an ordinary game session.
	tournamentReady map[tournamentMatchKey]map[string]struct{}
	tournamentGames map[tournamentMatchKey]*GameSession
	// The one conversation a bots-only event's matches all join, keyed by
	// tournament id. See tournament_chat.go.
	tournamentChats map[string]*chatRoom
	// Players practising against a client-side bot. The board itself never
	// reaches the server; this is presence only, so the lobby can say how many
	// people are busy with bots and a bot player can still be told that a real
	// opponent is waiting.
	botSessions map[*Client]botSession
	// Connected engine bots, keyed by bot id. Distinct from botSessions above,
	// which tracks *people* practising against a browser bot.
	// One entry per bot, holding one connection per concurrent game its owner
	// allowed it. See registerBot.
	bots map[string][]*Client
	// authLimiter throttles the routes that verify a password. Nothing else in
	// the backend is rate limited, because nothing else takes a guessable
	// secret and half a second of CPU to check one.
	authLimiter *rateLimiter
	// seriesLimiter throttles requests to pit two bots against each other, which
	// anybody may make and which cost two engines minutes of work each.
	seriesLimiter *rateLimiter
	// openingNameLimiter throttles proposing a name for an opening line.
	openingNameLimiter *rateLimiter
	// botSeriesRuns holds the in-flight bot-versus-bot runs.
	botSeriesRuns *botSeriesRunner
	// push is the only way this server reaches somebody who is not connected,
	// and therefore the only reason a seek may outlive its socket.
	push *pushSender

	// Discord sign-in, and the two short-lived maps it needs: one for a flow
	// that is out at Discord's consent screen, one for a finished conversation
	// waiting to be redeemed. Both are in memory on purpose — see ttlStore.
	discord        *discordAuth
	discordFlows   *ttlStore[discordFlow]
	discordTickets *ttlStore[discordTicket]
	// Pairs that have been made but not seated: the thirty seconds in which a
	// summoned player can still come and take their seat. Guarded by mu, like
	// the tournament readiness maps they are modelled on.
	// publicBaseURL is how this server is reached from outside, used to build
	// the download links the bot client and its guide page hand to people.
	// Optional: when it is unset the links are built from the address each
	// request arrived on instead. See publicBaseURLFor.
	publicBaseURL string
	// seriesDelay overrides the pause between series games. Zero means the
	// default; tests set it so a four-game series does not take three seconds
	// of wall clock to prove a pairing rule.
	seriesDelay time.Duration
	// seriesAwayOverride overrides how long a run waits for an engine that has
	// gone offline before writing the run off. Zero means the default; tests
	// set it so proving the rule does not cost fifteen seconds of wall clock.
	// Read through seriesAwayGrace.
	seriesAwayOverride time.Duration
	// update is the graceful restart, if one is under way: no new games, and
	// the process exits when the last one on the board finishes. See
	// deploy_drain.go. Its own lock rather than mu, because every path that
	// opens a game asks it a question while holding mu.
	update updateDrainFields
	// notices is the one standing announcement an administrator may put in
	// front of everybody. See announcements.go.
	notices noticeBoard
	// restrictions is every account sanction in force, held in memory because
	// chat and challenges ask about it constantly. Its own lock, like the two
	// above, because the gates that consult it are called from inside mu. See
	// moderation.go.
	restrictions moderationBoard
	// reservations is which engines are being held for a tournament they have
	// entered, for the same reason and with the same locking. See
	// bot_reserve.go.
	reservations reservationBoard
	// weekend is the recurring bot event's scheduler state: when it last looked
	// at the clock, and which matches it is waiting on. See weekend.go.
	weekend *weekendState
}

// botSession is what the server knows about a bot game: who is playing one,
// in which mode, and since when.
type botSession struct {
	modeID    game.ModeID
	startedAt time.Time
}

func New(allowedOrigins []string) *Server {
	return NewWithRegistry(game.DefaultModeRegistry, allowedOrigins)
}

func NewWithRegistry(registry *game.ModeRegistry, allowedOrigins []string) *Server {
	data, err := persistence.Open(":memory:")
	if err != nil {
		panic(fmt.Sprintf("initialize in-memory persistence: %v", err))
	}
	return NewWithRegistryAndStore(registry, data, allowedOrigins)
}

func NewWithStore(data *persistence.Store, allowedOrigins []string) *Server {
	return NewWithRegistryAndStore(game.DefaultModeRegistry, data, allowedOrigins)
}

func NewWithStoreAndAdminToken(
	data *persistence.Store,
	allowedOrigins []string,
	adminToken string,
) *Server {
	server := NewWithRegistryAndStore(game.DefaultModeRegistry, data, allowedOrigins)
	server.setAdminToken(adminToken)
	return server
}

func NewWithRegistryAndStore(
	registry *game.ModeRegistry,
	data *persistence.Store,
	allowedOrigins []string,
) *Server {
	if data == nil {
		panic("server persistence store is required")
	}
	originAllowed := originChecker(allowedOrigins)
	server := &Server{
		hub:            NewHub(),
		registry:       registry,
		data:           data,
		originAllowed:  originAllowed,
		participants:   make(map[*Client]Participant),
		games:          make(map[string]*GameSession),
		completedGames: make(map[string]CompletedGame),
		spectating:     make(map[*Client]*GameSession),

		postGameRooms:   make(map[string]*GameSession),
		postGameMembers: make(map[*Client]Participant),

		tournamentReady: make(map[tournamentMatchKey]map[string]struct{}),
		tournamentGames: make(map[tournamentMatchKey]*GameSession),
		tournamentChats: make(map[string]*chatRoom),
		weekend:         newWeekendState(),

		botSessions:        make(map[*Client]botSession),
		bots:               make(map[string][]*Client),
		authLimiter:        newRateLimiter(authAttemptBurst, authAttemptWindow),
		seriesLimiter:      newRateLimiter(seriesAttemptBurst, seriesAttemptWindow),
		openingNameLimiter: newRateLimiter(openingNameBurst, openingNameWindow),
		botSeriesRuns:      newBotSeriesRunner(),
		push:               newPushSender(data),
		discord:            newDiscordAuth(),
		discordFlows:       newTTLStore[discordFlow](discordFlowLifetime, discordMaximumPending),
		discordTickets:     newTTLStore[discordTicket](discordTicketLifetime, discordMaximumPending),
	}
	server.update.exit = make(chan struct{})
	// The board stops pairing while the server is being replaced. Asked as a
	// predicate rather than set as a flag so there is one answer to "is this
	// server taking new games", and it lives in deploy_drain.go.
	server.seeks = newSeekBoard(server.startPairedMatch)
	server.seeks.paused = server.isUpdating
	// A subscription pruned for being dead is the moment somebody stops being
	// reachable, and therefore the moment any wait they left behind stops being
	// honest.
	server.push.onUnreachable = server.dropUnreachableSeeks
	server.upgrader = websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin:     originAllowed,
	}
	server.canonicalizeOpeningNames()
	// Read once, here, for the reason moderation.go explains at length: the
	// paths that ask about a sanction are the hottest paths in the server.
	server.loadRestrictions(context.Background())
	return server
}

func (server *Server) Run(ctx context.Context) {
	go server.seeks.Run(ctx)
	// Its own goroutine, not the lobby ticker: a compile replays every archived
	// game in the mode. See opening_stats.go.
	go server.runOpeningStats(ctx)
	lobbyTicker := time.NewTicker(matchmakingTick)
	clockTicker := time.NewTicker(100 * time.Millisecond)
	defer lobbyTicker.Stop()
	defer clockTicker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-lobbyTicker.C:
			server.broadcastQueueStatus(now)
			server.expireChallenges(now)
			server.expireBotExchanges(now)
			server.expireUnstartedGames(now)
			// Before autoReadyBotMatches, which is the one path that *wants*
			// a reserved engine: the pairing it does is the reservation being
			// honoured rather than broken.
			server.refreshBotReservations()
			server.autoReadyBotMatches()
			server.pruneTournamentChats()
			// Before the shutdowns, because a run resuming or being written off
			// is a drain's list of commitments changing, and settling a drain
			// against last tick's list is how a bot gets told to stop while it
			// still owes half a pair.
			server.resumeStalledSeries(now)
			server.settleBotShutdowns()
			// The recurring bot event. Guarded to do real work at most once a
			// minute; the rest of the time it is one config read. See weekend.go.
			server.runWeekend(now)
			server.settleWeekendForfeits(now)
			server.settleUpdateDrain()
			server.authLimiter.sweep()
			server.seriesLimiter.sweep()
			server.openingNameLimiter.sweep()
			server.pruneRestrictions(now)
			server.discordFlows.sweep()
			server.discordTickets.sweep()
		case now := <-clockTicker.C:
			server.expireGames(now)
		}
	}
}

func (server *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		// `build` is how a deploy tells the process it just started from the one
		// it replaced. Both answer "ok" and both are healthy; only the stamp
		// says which binary is answering. See buildStamp.
		status := "ok"
		if server.isUpdating() {
			// Still serving — games are being played on it — but not taking new
			// ones, which is the distinction anything in front of this server
			// wants to make.
			status = "draining"
		}
		_ = json.NewEncoder(writer).Encode(map[string]string{
			"status": status,
			"build":  buildStamp(),
		})
	})
	mux.HandleFunc("GET /api/notice", server.getNotice)
	mux.HandleFunc("GET /api/modes", func(writer http.ResponseWriter, _ *http.Request) {
		writer.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(writer).Encode(server.registry.CatalogueDefinitions())
	})
	mux.HandleFunc("GET /api/accounts/{userID}", server.getAccount)
	mux.HandleFunc("PATCH /api/accounts/{userID}", server.updateAccount)
	mux.HandleFunc("GET /api/accounts/{userID}/games", server.getGameHistory)
	mux.HandleFunc("GET /api/accounts/{userID}/games/pgn", server.getAccountGamePGNs)
	mux.HandleFunc("GET /api/games/{gameID}/pgn", server.getGamePGN)
	mux.HandleFunc("GET /api/games/{gameID}/accuracy", server.getGameAccuracy)
	mux.HandleFunc("PUT /api/games/{gameID}/accuracy", server.putGameAccuracy)
	mux.HandleFunc(
		"GET /api/accounts/{userID}/record/{opponentID}",
		server.getHeadToHeadRecord,
	)
	mux.HandleFunc("GET /api/leaderboard", server.getLeaderboard)
	// The public player pages. Addressed by username or by user id — see
	// profile_routes.go — and open to anybody, like the ladder they hang off.
	mux.HandleFunc("GET /api/players", server.listPlayerProfiles)
	mux.HandleFunc("GET /api/players/{handle}", server.getPlayerProfile)
	mux.HandleFunc("GET /api/players/{handle}/games", server.getPlayerGames)
	mux.HandleFunc("GET /api/titles", server.getTitles)
	mux.HandleFunc("PUT /api/accounts/{userID}/title", server.setAccountTitle)
	mux.HandleFunc("GET /api/tournaments", server.getTournaments)
	mux.HandleFunc("GET /api/tournaments/{tournamentID}", server.getTournament)
	mux.HandleFunc(
		"POST /api/tournaments/{tournamentID}/signups",
		server.signupForTournament,
	)
	// The entrant's own withdrawal, as against the host's in the admin block
	// below. Signed in, and registration only. See withdrawFromTournament.
	mux.HandleFunc(
		"DELETE /api/tournaments/{tournamentID}/signups",
		server.withdrawFromTournament,
	)
	// The weekend bot arena. One read for the whole page; one write per vote.
	mux.HandleFunc("GET /api/weekend", server.getWeekend)
	mux.HandleFunc("POST /api/weekend/votes", server.castWeekendVote)
	// When you can play, as a whole set. See setWeekendAvailability for why it
	// is a set rather than a choice.
	mux.HandleFunc("PUT /api/weekend/availability", server.setWeekendAvailability)
	mux.HandleFunc("GET /api/admin/weekend", server.adminOnly(server.getWeekendConfig))
	mux.HandleFunc("PUT /api/admin/weekend", server.adminOnly(server.saveWeekendConfig))
	mux.HandleFunc("POST /api/admin/weekend/open", server.adminOnly(server.runWeekendNow))
	mux.HandleFunc("GET /api/identity/policy", server.identityPolicy)
	mux.HandleFunc("GET /api/push/key", server.getPushKey)
	mux.HandleFunc("POST /api/push/subscriptions", server.subscribeToPush)
	mux.HandleFunc("DELETE /api/push/subscriptions", server.unsubscribeFromPush)
	mux.HandleFunc("POST /api/push/devices", server.registerPushDevice)
	mux.HandleFunc("DELETE /api/push/devices", server.unregisterPushDevice)
	mux.HandleFunc("POST /api/push/test", server.sendTestPush)
	// No register route: an account is created by signing in with Discord.
	// Login stays for the accounts that still hold a password, and goes when
	// the last of them has linked.
	mux.HandleFunc("POST /api/auth/discord/start", server.startDiscordAuth)
	mux.HandleFunc("GET /api/auth/discord/callback", server.discordCallback)
	mux.HandleFunc("POST /api/auth/discord/exchange", server.exchangeDiscordTicket)
	mux.HandleFunc("POST /api/auth/discord/complete", server.completeDiscordSignup)
	mux.HandleFunc("POST /api/auth/login", server.loginAccount)
	mux.HandleFunc("POST /api/auth/logout", server.logoutAccount)
	mux.HandleFunc("GET /api/auth/me", server.currentAccount)

	mux.HandleFunc("GET /api/bots", server.listBots)
	mux.HandleFunc("POST /api/bots", server.createBot)
	mux.HandleFunc("GET /api/bots/mine", server.listMyBots)
	mux.HandleFunc("PATCH /api/bots/{botID}", server.updateBot)
	mux.HandleFunc("POST /api/bots/{botID}/token", server.rotateBotToken)
	mux.HandleFunc("DELETE /api/bots/{botID}", server.deleteBot)
	mux.HandleFunc("POST /api/bots/{botID}/shutdown", server.shutdownBot)
	mux.HandleFunc("DELETE /api/bots/{botID}/shutdown", server.resumeBot)
	// Answers to a bot id or to a bot's account id, so every list that shows a
	// bot can build this URL from whichever of the two it already carries.
	mux.HandleFunc("GET /api/bots/{botID}/icon.png", server.getBotIcon)
	// The host's way to fill a bots-only field from whatever is online. The
	// owner-facing door is POST /api/tournaments/{id}/signups with a botId.
	mux.HandleFunc(
		"POST /api/admin/tournaments/{tournamentID}/enroll-bots",
		server.adminOnly(server.enrollBots),
	)
	mux.HandleFunc("GET /api/bot-series", server.getBotSeriesList)
	mux.HandleFunc("GET /api/bot-series/{seriesID}", server.getBotSeries)
	mux.HandleFunc("GET /api/bot-matches", server.getBotMatches)
	// Public, with the ceilings in bot_series.go. The administrative pair below
	// is the same call without them.
	mux.HandleFunc("POST /api/bot-series", server.startBotSeries)
	mux.HandleFunc("POST /api/bot-series/{seriesID}/abort", server.abortBotSeries)
	mux.HandleFunc("POST /api/admin/bot-series", server.adminOnly(server.startAdminBotSeries))
	mux.HandleFunc(
		"POST /api/admin/bot-series/{seriesID}/abort",
		server.adminOnly(server.abortAdminBotSeries),
	)
	mux.HandleFunc("GET /api/bot/version", server.getBotClientVersion)
	mux.HandleFunc("GET /api/bot/guide", server.getBotGuide)
	mux.HandleFunc("GET /api/bot/rpsbot.py", server.getBotClientScript)
	mux.HandleFunc("GET /api/bot/example_engine.py", server.getExampleEngine)

	mux.HandleFunc("GET /api/admin/session", server.adminOnly(server.getAdminSession))
	// The graceful restart: stop taking games, wait out the ones being played,
	// then exit for systemd to bring the new binary up. deploy-backend.sh drives
	// all three, and the admin screen offers the same buttons.
	mux.HandleFunc("POST /api/admin/drain", server.adminOnly(server.beginUpdateDrain))
	mux.HandleFunc("DELETE /api/admin/drain", server.adminOnly(server.cancelUpdateDrain))
	mux.HandleFunc("GET /api/admin/drain", server.adminOnly(server.getUpdateDrain))
	mux.HandleFunc("POST /api/admin/notice", server.adminOnly(server.postNotice))
	mux.HandleFunc("DELETE /api/admin/notice", server.adminOnly(server.clearNotice))
	mux.HandleFunc("GET /api/openings/{modeID}", server.getOpeningBook)
	// One position, resolved from `?line=d9-c8,d2-c3`. The book is a graph the
	// server owns; a visitor walks it a layer at a time rather than downloading
	// it.
	mux.HandleFunc("GET /api/openings/{modeID}/node", server.getOpeningNode)
	// Just the names, for the board: every live game asks what the opening it
	// is playing is called, and none of them wants the book to answer it.
	mux.HandleFunc("GET /api/openings/{modeID}/names", server.getOpeningNames)
	// Naming a line, published on the spot. Checked against the rules rather
	// than against the book, so an opening RPSFish never analyzed can be named
	// -- which is most of the interesting ones.
	mux.HandleFunc("POST /api/openings/{modeID}/names", server.nameOpeningLine)
	// The searchable index of every name. The openings page leads with the
	// engine's certified lines and does not list player names beside them; this
	// is how they stay findable rather than merely stored.
	mux.HandleFunc("GET /api/openings/{modeID}/names/browse", server.browseOpeningNames)
	// What people actually play, recompiled from the archive daily. With no
	// `line` this is the whole condensed dataset for a mode in one response.
	mux.HandleFunc("GET /api/openings/{modeID}/stats", server.getOpeningStats)
	// The explorer's question, and the one the line-keyed statistics cannot
	// answer: how many games reached this *board*, by any move order, and what
	// did they play from it. The caller sends the line it walked and this
	// replays it, because the rules live here.
	mux.HandleFunc("GET /api/openings/{modeID}/explore", server.exploreOpeningPosition)
	mux.HandleFunc(
		"POST /api/openings/{modeID}/suggestions",
		server.suggestOpeningName,
	)
	mux.HandleFunc(
		"POST /api/admin/openings/{modeID}/stats",
		server.adminOnly(server.recompileOpeningStats),
	)
	mux.HandleFunc(
		"PUT /api/admin/openings/{modeID}",
		server.adminOnly(server.importOpeningBook),
	)
	// Public: a line with no name shows what people have called it, so the
	// queue is something a visitor reads rather than something only a curator
	// can see.
	mux.HandleFunc(
		"GET /api/openings/{modeID}/suggestions",
		server.getOpeningNameSuggestions,
	)
	mux.HandleFunc(
		"PUT /api/admin/openings/{modeID}/names",
		server.adminOnly(server.setOpeningName),
	)
	mux.HandleFunc(
		"DELETE /api/admin/openings/{modeID}/names",
		server.adminOnly(server.deleteOpeningName),
	)
	mux.HandleFunc(
		"POST /api/admin/openings/{modeID}/suggestions/{suggestionID}/approve",
		server.adminOnly(server.approveOpeningNameSuggestion),
	)
	mux.HandleFunc(
		"DELETE /api/admin/openings/{modeID}/suggestions/{suggestionID}",
		server.adminOnly(server.rejectOpeningNameSuggestion),
	)
	mux.HandleFunc("GET /api/admin/accounts", server.adminOnly(server.listAccounts))
	mux.HandleFunc(
		"PATCH /api/admin/accounts/{userID}",
		server.adminOnly(server.updateAccountAdmin),
	)
	mux.HandleFunc(
		"GET /api/admin/accounts/{userID}",
		server.adminOnly(server.getAccountDetail),
	)
	mux.HandleFunc("DELETE /api/admin/accounts/{userID}", server.adminOnly(server.deleteAccount))
	mux.HandleFunc(
		"PUT /api/admin/accounts/{userID}/titles/{title}",
		server.adminOnly(server.grantAccountTitle),
	)
	mux.HandleFunc(
		"DELETE /api/admin/accounts/{userID}/titles/{title}",
		server.adminOnly(server.revokeAccountTitle),
	)
	// A separate path rather than a flag on the route above: this one does not
	// anonymize, it deletes, and the two should not be one typo apart.
	mux.HandleFunc(
		"DELETE /api/admin/accounts/{userID}/purge",
		server.adminOnly(server.purgeAccount),
	)
	mux.HandleFunc("DELETE /api/admin/bots/{botID}", server.adminOnly(server.deleteAdminBot))
	mux.HandleFunc(
		"GET /api/admin/accounts/{userID}/restrictions",
		server.adminOnly(server.listAccountRestrictions),
	)
	mux.HandleFunc(
		"POST /api/admin/accounts/{userID}/restrictions",
		server.adminOnly(server.restrictAccount),
	)
	mux.HandleFunc(
		"DELETE /api/admin/accounts/{userID}/restrictions/{kind}",
		server.adminOnly(server.liftAccountRestriction),
	)
	mux.HandleFunc("GET /api/admin/analytics", server.adminOnly(server.getAdminAnalytics))
	mux.HandleFunc("GET /api/admin/live-games", server.adminOnly(server.listAdminLiveGames))
	mux.HandleFunc(
		"POST /api/admin/live-games/{gameID}/stop",
		server.adminOnly(server.stopGame),
	)
	mux.HandleFunc("GET /api/admin/bots", server.adminOnly(server.listAdminBots))
	mux.HandleFunc(
		"POST /api/admin/bots/{botID}/disconnect",
		server.adminOnly(server.disconnectBotSockets),
	)
	mux.HandleFunc("GET /api/admin/games", server.adminOnly(server.listAdminGames))
	mux.HandleFunc("DELETE /api/admin/games/{gameID}", server.adminOnly(server.deleteAdminGame))
	mux.HandleFunc("GET /api/admin/games/pgn", server.adminOnly(server.exportGamePGNs))
	// The tournament builder. Create and start keep their addresses; the rest
	// of the lifecycle — editing a draft, publishing it, calling it off — is
	// new, and so is reading the board with drafts on it.
	mux.HandleFunc(
		"POST /api/admin/tournaments",
		server.adminOnly(server.createTournament),
	)
	mux.HandleFunc(
		"GET /api/admin/tournaments",
		server.adminOnly(server.listAdminTournaments),
	)
	mux.HandleFunc(
		"PATCH /api/admin/tournaments/{tournamentID}",
		server.adminOnly(server.updateTournament),
	)
	mux.HandleFunc(
		"DELETE /api/admin/tournaments/{tournamentID}",
		server.adminOnly(server.deleteTournament),
	)
	mux.HandleFunc(
		"POST /api/admin/tournaments/{tournamentID}/publish",
		server.adminOnly(server.publishTournament),
	)
	mux.HandleFunc(
		"DELETE /api/admin/tournaments/{tournamentID}/publish",
		server.adminOnly(server.unpublishTournament),
	)
	mux.HandleFunc(
		"POST /api/admin/tournaments/{tournamentID}/cancel",
		server.adminOnly(server.cancelTournament),
	)
	// Taking a finished event off the board, and putting it back. Distinct from
	// cancelling, which is about the event, and from deleting, which destroys
	// it: this only changes what is listed. See SetTournamentHidden.
	mux.HandleFunc(
		"POST /api/admin/tournaments/{tournamentID}/hide",
		server.adminOnly(server.hideTournament),
	)
	mux.HandleFunc(
		"DELETE /api/admin/tournaments/{tournamentID}/hide",
		server.adminOnly(server.showTournament),
	)
	mux.HandleFunc(
		"POST /api/admin/tournaments/{tournamentID}/advance",
		server.adminOnly(server.advanceTournament),
	)
	mux.HandleFunc(
		"DELETE /api/admin/tournaments/{tournamentID}/players/{playerID}",
		server.adminOnly(server.withdrawTournamentPlayer),
	)
	mux.HandleFunc(
		"POST /api/admin/tournaments/{tournamentID}/start",
		server.adminOnly(server.startTournament),
	)
	mux.HandleFunc(
		"PATCH /api/admin/tournaments/{tournamentID}/matches/{matchID}",
		server.adminOnly(server.updateTournamentMatch),
	)
	mux.HandleFunc("GET /ws", server.handleWebSocket)
	return server.withCORS(mux)
}

// SetPublicBaseURL tells the server the canonical address to publish links on.
//
// Worth setting when that differs from what callers connect to — a CDN, or a
// second hostname — and otherwise optional, since publicBaseURLFor falls back
// to the request.
func (server *Server) SetPublicBaseURL(base string) {
	server.publicBaseURL = strings.TrimSpace(base)
}

func (server *Server) setAdminToken(token string) {
	token = strings.TrimSpace(token)
	server.adminEnabled = token != ""
	server.adminTokenHash = sha256.Sum256([]byte(token))
}

func (server *Server) hasValidAdminToken(request *http.Request) bool {
	authorization := strings.TrimSpace(request.Header.Get("Authorization"))
	scheme, token, found := strings.Cut(authorization, " ")
	if !found || !strings.EqualFold(scheme, "Bearer") || strings.TrimSpace(token) == "" {
		return false
	}
	return server.hasValidAdminTokenValue(token)
}

func (server *Server) hasValidAdminTokenValue(token string) bool {
	if !server.adminEnabled || strings.TrimSpace(token) == "" {
		return false
	}
	providedHash := sha256.Sum256([]byte(strings.TrimSpace(token)))
	return subtle.ConstantTimeCompare(
		server.adminTokenHash[:],
		providedHash[:],
	) == 1
}

// adminOnly gates a route on being an administrator, by either door.
//
// The order matters. `adminEnabled` describes only the shared-token door: it is
// false when no RPS_ADMIN_TOKEN is configured. Checking it first — which this
// used to do — answered 503 to a signed-in administrator holding a perfectly
// good session, so the isAdmin account flag was unusable on any deployment
// without the environment variable set. Ask who the caller is first, and let
// "not configured" describe the only case it actually describes.
func (server *Server) adminOnly(next http.HandlerFunc) http.HandlerFunc {
	return func(writer http.ResponseWriter, request *http.Request) {
		if server.requestIsAdmin(request) {
			next(writer, request)
			return
		}
		if !server.adminEnabled {
			writeAPIError(writer, http.StatusServiceUnavailable, "admin commands are not configured")
			return
		}
		writer.Header().Set("WWW-Authenticate", `Bearer realm="tournament-admin"`)
		writeAPIError(writer, http.StatusUnauthorized, "invalid admin token")
	}
}

func (server *Server) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		origin := request.Header.Get("Origin")
		if origin != "" && server.originAllowed(request) {
			writer.Header().Set("Access-Control-Allow-Origin", origin)
			writer.Header().Add("Vary", "Origin")
			writer.Header().Set(
				"Access-Control-Allow-Methods",
				"GET, POST, PUT, PATCH, DELETE, OPTIONS",
			)
			writer.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
			if request.Method == http.MethodOptions {
				writer.WriteHeader(http.StatusNoContent)
				return
			}
		} else if request.Method == http.MethodOptions {
			writeAPIError(writer, http.StatusForbidden, "origin is not allowed")
			return
		}
		next.ServeHTTP(writer, request)
	})
}

// authenticateBrowser resolves who is on the other end of a browser socket.
//
// A signed-in player is identified by their session token, so their account
// follows them to a second browser instead of leaving them playing there as a
// stranger. Everyone else is the anonymous identity this browser generated,
// which is what its local profile key proves ownership of.
func (server *Server) authenticateBrowser(
	ctx context.Context,
	authentication ClientMessage,
) (persistence.Account, error) {
	if token := strings.TrimSpace(authentication.SessionToken); token != "" {
		return server.data.SessionAccount(ctx, token)
	}
	return server.data.EnsureAccountWithProfileKey(
		ctx,
		authentication.UserID,
		"Guest",
		authentication.ProfileKey,
	)
}

func (server *Server) handleWebSocket(writer http.ResponseWriter, request *http.Request) {
	connection, err := server.upgrader.Upgrade(writer, request, nil)
	if err != nil {
		log.Printf("websocket upgrade: %v", err)
		return
	}
	// A bot's registration is larger than a browser's first message — it can
	// carry an icon — so the pre-authentication limit has to admit it. readPump
	// then applies the smaller per-client limit, which is why these are two
	// constants rather than one: nothing after this frame is allowed to be
	// this big.
	connection.SetReadLimit(botAuthMaxMessage)
	_ = connection.SetReadDeadline(time.Now().Add(authenticationTimeout))
	var authentication ClientMessage
	if err := connection.ReadJSON(&authentication); err != nil ||
		(authentication.Type != "authenticate" && authentication.Type != "authenticate_bot") {
		_ = connection.WriteJSON(ServerMessage{
			Type:    "authentication_failed",
			Message: "send the local account key before using online play",
		})
		_ = connection.Close()
		return
	}

	if authentication.Type == "authenticate_bot" {
		server.acceptBotConnection(
			request.Context(), connection, authentication,
			server.publicBaseURLFor(request),
		)
		return
	}

	account, err := server.authenticateBrowser(request.Context(), authentication)
	if err != nil {
		message := "this device's local account key does not match the account"
		if authentication.SessionToken != "" {
			message = "your session has expired, so sign in again"
		}
		_ = connection.WriteJSON(ServerMessage{Type: "authentication_failed", Message: message})
		_ = connection.Close()
		return
	}
	// Before the profile is built, so a title earned in a game played before
	// this connection is already on the name this session plays under.
	account = server.titledAccount(request.Context(), account)
	profile := playerProfile(account)

	client := &Client{
		connection: connection,
		send:       make(chan []byte, sendBuffer),
		done:       make(chan struct{}),
		profile:    profile,
		account:    account,
		server:     server,
		readLimit:  maxMessage,
	}
	server.hub.Register(client)
	// Whatever this person was already waiting behind is handed straight back,
	// so a reconnection — or a second tab — resumes a search rather than being
	// told nothing and having to guess.
	queue := server.rebindSeek(client)
	// The board may have opened while this browser was closed, in which case it
	// has never heard of the game and cannot ask to rejoin one by id. Naming it
	// here is what makes a notification worth opening.
	liveGameID := server.liveGameFor(account.UserID)
	defaultTimeControl := game.DefaultTimeControl()
	transports := server.push.transports()
	// Both of these are why they are held on the server rather than only
	// broadcast: somebody reloading the page mid-deploy, or arriving a minute
	// after the announcement went out, is exactly the person who needs to be
	// told. Sent unconditionally — an update that is not happening is an
	// `updating: false` the client hides the banner for.
	updateState := server.UpdateDrainState()
	notice := server.notices.current()
	// The same reasoning one more time: somebody arriving in the middle of a
	// scheduled bench needs to be told why the whole bot ladder is unavailable,
	// and somebody arriving an hour before one needs to be told it is coming.
	botBench := botBenchState(time.Now())
	client.Send(ServerMessage{
		Type:               "connection_ready",
		Update:             &updateState,
		Notice:             notice,
		BotBench:           &botBench,
		Modes:              server.registry.CatalogueDefinitions(),
		ModePlayerCounts:   server.modePlayerCounts(),
		ModeQueueCounts:    server.seeks.CountsByMode(),
		ModeReadyCounts:    server.modeReadyCounts(),
		BotPlayerCount:     server.botPlayerCount(),
		OnlineCount:        server.onlineCount(),
		EngineBots:         server.botRoster(),
		LiveGames:          server.liveGames(),
		Tournaments:        server.tournamentSnapshots(request.Context()),
		Challenges:         server.pendingChallengesFor(client, time.Now()),
		OpenChallenges:     server.openChallenges(time.Now()),
		Account:            &account,
		DefaultTimeControl: &defaultTimeControl,
		Queue:              queue,
		GameID:             liveGameID,
		PushEnabled:        server.push.enabled(),
		PushTransports:     &transports,
		Restrictions:       server.activeRestrictions(account.UserID),
	})
	go client.writePump()
	client.readPump()
}

func (server *Server) handleMessage(client *Client, message ClientMessage) {
	switch message.Type {
	case "send_challenge":
		server.sendChallenge(client, message.Username, message.requestedSetup())
	case "accept_challenge":
		server.acceptChallenge(client, message.ChallengeID)
	case "decline_challenge":
		server.declineChallenge(client, message.ChallengeID)
	case "cancel_challenge":
		server.cancelChallenge(client, message.ChallengeID)
	case "queue_presence":
		server.setQueuePresence(client, message.Present)
	case "join_queue":
		server.joinQueue(client, message.requestedSetup())
	case "leave_queue":
		server.leaveQueue(client)
	case "bot_session_start":
		// A bot game is played entirely in the browser, so the only thing to
		// validate is the mode it claims to be practising.
		if !server.registry.Has(message.ModeID) {
			client.Send(ServerMessage{Type: "error", Message: "invalid game mode"})
			return
		}
		server.startBotSession(client, message.ModeID)
	case "bot_session_end":
		server.endBotSession(client)
	case "rejoin_game":
		server.rejoinGame(client, message.GameID)
	case "spectate_game":
		// A posted game and a plain search are both reasons not to be watching
		// somebody else, and each is worth saying in its own words. The plain
		// search is caught by spectateGame itself.
		if seek := server.seeks.ForClient(client); seek != nil && !seek.Queued {
			client.Send(ServerMessage{Type: "spectate_unavailable", Message: "cancel your pending challenge before spectating"})
			return
		}
		server.spectateGame(client, message.GameID)
	case "stop_spectating":
		server.stopSpectating(client, true)
	case "leave_game":
		server.leaveGame(client)
	case "tournament_ready":
		server.readyForTournamentMatch(client, message.TournamentID, message.MatchID)
	case "tournament_withdraw":
		server.withdrawFromTournamentMatch(client, message.TournamentID, message.MatchID)
	case "send_chat":
		server.sendChat(client, message.Text)
	case "bot_drain":
		server.handleBotDrainRequest(client, message)
	case "engine_reply", "engine_error":
		server.handleEngineReply(client, message)
	case "challenge_bot":
		server.challengeBot(client, message.BotID, message.ModeID, message.TimeControl, message.PreferredColor)
	case "make_move":
		_ = server.makeMove(client, message.From, message.To)
	case "request_moves":
		server.sendValidMoves(client, message.From)
	case "offer_draw":
		server.offerDraw(client)
	case "accept_draw":
		server.acceptDraw(client)
	case "decline_draw":
		server.declineDraw(client)
	case "offer_time":
		server.offerTimeExtension(client)
	case "accept_time":
		server.acceptTimeExtension(client)
	case "decline_time":
		server.declineTimeExtension(client)
	case "resign_game":
		server.resign(client)
	case "abort_game":
		server.abortGame(client)
	default:
		client.Send(ServerMessage{Type: "error", Message: "unknown message type"})
	}
}

func (server *Server) spectateGame(client *Client, gameID string) {
	gameID = strings.TrimSpace(gameID)
	if gameID == "" {
		client.Send(ServerMessage{Type: "spectate_unavailable", Message: "missing game session id"})
		return
	}
	if server.participantFor(client) != nil {
		client.Send(ServerMessage{Type: "spectate_unavailable", Message: "players cannot spectate during a game"})
		return
	}
	if server.seeks.ForClient(client) != nil {
		client.Send(ServerMessage{Type: "spectate_unavailable", Message: "leave matchmaking before spectating"})
		return
	}
	server.leaveRoom(client)

	changed := false
	server.mu.Lock()
	session, ok := server.games[gameID]
	if !ok {
		server.mu.Unlock()
		client.Send(ServerMessage{Type: "spectate_unavailable", Message: "that game is no longer live"})
		return
	}
	state := session.game.Snapshot()
	if colorForUser(state, client.profile.UserID) != game.Neutral {
		server.mu.Unlock()
		client.Send(ServerMessage{Type: "spectate_unavailable", Message: "rejoin your game instead of spectating it"})
		return
	}
	var leftRoom *chatRoom
	if previous := server.spectating[client]; previous != nil && previous != session {
		delete(previous.spectators, client)
		leftRoom = previous.chat
		changed = true
	}
	if session.spectators == nil {
		session.spectators = make(map[*Client]struct{})
	}
	if _, alreadyWatching := session.spectators[client]; !alreadyWatching {
		session.spectators[client] = struct{}{}
		changed = true
	}
	server.spectating[client] = session
	history := session.chat.history()
	// Queued while still holding the lock that guards the spectator set, so
	// this is first in the client's channel. A broadcast can only see the
	// membership we just added once this unlocks, which is the only way it
	// could beat the message that is supposed to introduce the room. Send is
	// a non-blocking buffered write, so the lock is not held on anything slow.
	client.Send(ServerMessage{
		Type:      "spectator_joined",
		Color:     game.Neutral,
		GameState: &state,
		// The moves that made the position above. Somebody who joins at move
		// twenty has seen none of them, and they are the reader this exists
		// for. See ServerMessage.PGN.
		PGN:           livePGN(session),
		ChatMessages:  history,
		ChatRoomID:    session.chat.id,
		ChatRoomScope: session.chat.scope,
		ChatOccupancy: session.chat.occupancy(),
	})
	server.mu.Unlock()

	if changed {
		server.broadcastLiveGames()
		if leftRoom != session.chat {
			server.announceRoomOccupancy(leftRoom)
		}
		server.announceRoomOccupancy(session.chat)
	}
}

func (server *Server) stopSpectating(client *Client, notify bool) {
	server.mu.Lock()
	session := server.spectating[client]
	if session != nil {
		delete(server.spectating, client)
		delete(session.spectators, client)
	}
	server.mu.Unlock()

	if session == nil {
		return
	}
	if notify {
		client.Send(ServerMessage{Type: "spectator_left"})
	}
	server.broadcastLiveGames()
	server.announceRoomOccupancy(session.chat)
}

// leaveGame is the client's way of saying it has navigated away from a game.
// It covers a spectator watching a live game and anyone still sitting in a
// finished game's chat room.
func (server *Server) leaveGame(client *Client) {
	if server.leaveRoom(client) {
		return
	}
	server.stopSpectating(client, false)
}

// leaveRoom drops a client out of a finished game's chat room and reports
// whether it was in one. The room closes behind the last member so a finished
// session is not retained for a browser tab nobody is looking at.
func (server *Server) leaveRoom(client *Client) bool {
	server.mu.Lock()
	room := server.leaveRoomLocked(client)
	server.mu.Unlock()
	server.announceRoomOccupancy(room)
	return room != nil
}

// leaveRoomLocked returns the conversation the client was in, or nil when it
// was in none. The caller announces the room's new occupancy once it has let
// the lock go.
func (server *Server) leaveRoomLocked(client *Client) *chatRoom {
	member, ok := server.postGameMembers[client]
	if !ok {
		return nil
	}
	delete(server.postGameMembers, client)
	session := member.session
	switch member.color {
	case game.Red:
		if session.redClient == client {
			session.redClient = nil
		}
	case game.Blue:
		if session.blueClient == client {
			session.blueClient = nil
		}
	default:
		delete(session.spectators, client)
	}
	if session.redClient == nil && session.blueClient == nil && len(session.spectators) == 0 {
		if current, found := server.postGameRooms[session.gameID]; found && current == session {
			delete(server.postGameRooms, session.gameID)
		}
		// The game stops being somewhere messages are delivered. The
		// conversation itself is not over: a series holds its room between
		// games, when no game at all points at it.
		session.chat.leave(session)
	}
	return session.chat
}

// announceRoomOccupancy tells a conversation how many people are in it, and is
// called after anybody joins or leaves one. The count travels to the same
// audience a message would, so a room that has outlived its game keeps
// reporting itself to whoever is still sitting in it.
//
// Call without Server.mu held.
func (server *Server) announceRoomOccupancy(room *chatRoom) {
	if room == nil {
		return
	}
	server.mu.RLock()
	listeners := room.audience()
	server.mu.RUnlock()
	message := ServerMessage{
		Type:          "chat_presence",
		ChatRoomID:    room.id,
		ChatRoomScope: room.scope,
		ChatOccupancy: len(listeners),
	}
	for _, listener := range listeners {
		listener.Send(message)
	}
}

// chatSeatLocked resolves the game a client may chat in, which is either the
// live game it is playing or watching, or the chat room of a finished game it
// has not left yet.
func (server *Server) chatSeatLocked(
	client *Client,
) (*GameSession, string, game.PlayerColor) {
	if participant, ok := server.participants[client]; ok {
		if server.games[participant.session.gameID] == participant.session {
			return participant.session, "player", participant.color
		}
		return nil, "", ""
	}
	if watched := server.spectating[client]; watched != nil {
		if server.games[watched.gameID] == watched {
			return watched, "spectator", ""
		}
		return nil, "", ""
	}
	member, ok := server.postGameMembers[client]
	if !ok || server.postGameRooms[member.session.gameID] != member.session {
		return nil, "", ""
	}
	if member.color == game.Neutral {
		return member.session, "spectator", ""
	}
	return member.session, "player", member.color
}

func (server *Server) sendChat(client *Client, text string) {
	// First, before the message is even validated: a muted player should be
	// told they are muted rather than told their message was too long.
	if refusal := server.muteRefusal(client, "send chat messages"); refusal != "" {
		client.Send(ServerMessage{Type: "chat_rejected", Message: refusal})
		return
	}
	text = strings.TrimSpace(text)
	if text == "" {
		client.Send(ServerMessage{Type: "chat_rejected", Message: "chat messages cannot be empty"})
		return
	}
	if !utf8.ValidString(text) || utf8.RuneCountInString(text) > maximumChatRunes {
		client.Send(ServerMessage{
			Type:    "chat_rejected",
			Message: fmt.Sprintf("chat messages must be at most %d characters", maximumChatRunes),
		})
		return
	}
	messageID, err := randomID()
	if err != nil {
		client.Send(ServerMessage{Type: "chat_rejected", Message: "could not send chat message"})
		return
	}

	server.mu.Lock()
	session, role, color := server.chatSeatLocked(client)
	if session == nil {
		server.mu.Unlock()
		client.Send(ServerMessage{Type: "chat_rejected", Message: "join a game before chatting"})
		return
	}
	senderName := strings.TrimSpace(client.profile.Username)
	if senderName == "" {
		senderName = "Guest"
	}
	chatMessage := ChatMessage{
		ID:           messageID,
		RoomID:       session.chat.id,
		GameID:       session.gameID,
		SenderUserID: client.profile.UserID,
		SenderName:   senderName,
		SenderTitle:  client.profile.Title,
		SenderRole:   role,
		SenderColor:  color,
		Text:         text,
		SentAtUnixMs: time.Now().UnixMilli(),
	}
	session.chat.append(chatMessage)
	// The audience is read under the lock that appended, so everybody hears
	// this exactly once: whoever was in the room is sent it, and whoever
	// arrives after the unlock finds it in the history they are joined with.
	listeners := session.chat.audience()
	server.mu.Unlock()

	broadcast := ServerMessage{Type: "chat_message", ChatMessage: &chatMessage}
	for _, listener := range listeners {
		listener.Send(broadcast)
	}
}

// takeRoomSeatLocked reseats a returning player in a finished game's chat room
// and reports the stale connection it displaced, if any, along with the other
// room this client was pulled out of so the caller can announce its loss.
func (server *Server) takeRoomSeatLocked(
	client *Client,
	room *GameSession,
	color game.PlayerColor,
) (*Client, *chatRoom) {
	var left *chatRoom
	if member, ok := server.postGameMembers[client]; ok && member.session != room {
		left = server.leaveRoomLocked(client)
	}
	var replaced *Client
	switch color {
	case game.Red:
		replaced = room.redClient
		room.redClient = client
	case game.Blue:
		replaced = room.blueClient
		room.blueClient = client
	}
	if replaced != nil && replaced != client {
		delete(server.postGameMembers, replaced)
	}
	server.postGameMembers[client] = Participant{session: room, color: color}
	return replaced, left
}

func (server *Server) rejoinGame(client *Client, gameID string) {
	if strings.TrimSpace(gameID) == "" {
		client.Send(ServerMessage{Type: "game_unavailable", Message: "missing game session id"})
		return
	}

	now := time.Now()
	var oldClient *Client
	var participant Participant
	var opponentDeadline time.Time
	expiredColor := game.Neutral
	var terminalState *game.GameState
	var rejoinState game.GameState
	var chatHistory []ChatMessage
	var rejoinedRoom *chatRoom
	server.mu.Lock()
	session, ok := server.games[gameID]
	if !ok {
		// A finished game whose chat room is still open readmits its players,
		// so a dropped connection does not cut them out of the conversation.
		if room, open := server.postGameRooms[gameID]; open {
			state := room.game.Snapshot()
			if color := colorForUser(state, client.profile.UserID); color != game.Neutral {
				replaced, left := server.takeRoomSeatLocked(client, room, color)
				history := room.chat.history()
				roomID := room.chat.id
				roomScope := room.chat.scope
				occupancy := room.chat.occupancy()
				server.mu.Unlock()
				client.Send(ServerMessage{
					Type:          "game_rejoined",
					Color:         color,
					GameState:     &state,
					PGN:           livePGN(room),
					ChatMessages:  history,
					ChatRoomID:    roomID,
					ChatRoomScope: roomScope,
					ChatOccupancy: occupancy,
				})
				if replaced != nil && replaced != client {
					replaced.close()
				}
				server.announceRoomOccupancy(left)
				server.announceRoomOccupancy(room.chat)
				return
			}
		}
		completed, found := server.completedGames[gameID]
		if found && now.Before(completed.expiresAt) {
			color := colorForUser(completed.state, client.profile.UserID)
			if color != game.Neutral {
				client.Send(ServerMessage{
					Type:      "game_rejoined",
					Color:     color,
					GameState: &completed.state,
				})
				server.mu.Unlock()
				return
			}
		} else if found {
			delete(server.completedGames, gameID)
		}
		server.mu.Unlock()
		client.Send(ServerMessage{
			Type:    "game_unavailable",
			Message: "that game is no longer available",
		})
		return
	}

	rejoinState = session.game.Snapshot()
	chatHistory = session.chat.history()
	chatRoomID := session.chat.id
	chatRoomScope := session.chat.scope
	firstMoveDeadline := session.start.deadlineUnixMs()
	playerColor := colorForUser(rejoinState, client.profile.UserID)
	if playerColor == game.Neutral {
		server.mu.Unlock()
		client.Send(ServerMessage{
			Type:    "game_unavailable",
			Message: "that game is no longer available",
		})
		return
	}
	if rejoinState.Status == game.Finished {
		terminalState = &rejoinState
		client.Send(ServerMessage{
			Type:          "game_rejoined",
			Color:         playerColor,
			GameState:     &rejoinState,
			PGN:           livePGN(session),
			ChatMessages:  chatHistory,
			ChatRoomID:    chatRoomID,
			ChatRoomScope: chatRoomScope,
			ChatOccupancy: session.chat.occupancy(),
		})
		server.mu.Unlock()
		server.finishSession(session, *terminalState)
		return
	}

	switch playerColor {
	case game.Red:
		if deadline := session.reconnectDeadline(game.Red, rejoinState); !deadline.IsZero() &&
			!now.Before(deadline) {
			expiredColor = game.Red
		} else {
			participant = Participant{session: session, color: game.Red}
			oldClient = session.redClient
			session.redClient = client
			session.redDisconnectedAt = time.Time{}
			opponentDeadline = session.reconnectDeadline(game.Blue, rejoinState)
		}
	case game.Blue:
		if deadline := session.reconnectDeadline(game.Blue, rejoinState); !deadline.IsZero() &&
			!now.Before(deadline) {
			expiredColor = game.Blue
		} else {
			participant = Participant{session: session, color: game.Blue}
			oldClient = session.blueClient
			session.blueClient = client
			session.blueDisconnectedAt = time.Time{}
			opponentDeadline = session.reconnectDeadline(game.Red, rejoinState)
		}
	}
	if expiredColor == game.Neutral {
		if oldClient != nil && oldClient != client {
			delete(server.participants, oldClient)
		}
		server.participants[client] = participant
		// Read after the seat was taken, so a player who reconnects into an
		// empty seat counts themselves.
		rejoinedRoom = session.chat
		client.Send(ServerMessage{
			Type:      "game_rejoined",
			Color:     participant.color,
			GameState: &rejoinState,
			// The game so far, so a player who reloaded mid-match gets their
			// move list back rather than a board with no history behind it.
			PGN:                     livePGN(session),
			ChatMessages:            chatHistory,
			ChatRoomID:              chatRoomID,
			ChatRoomScope:           chatRoomScope,
			ChatOccupancy:           rejoinedRoom.occupancy(),
			ReconnectDeadlineUnixMs: deadlineUnixMilli(opponentDeadline),
			FirstMoveDeadlineUnixMs: firstMoveDeadline,
		})
		var opponent *Client
		if participant.color == game.Red {
			opponent = participant.session.blueClient
		} else {
			opponent = participant.session.redClient
		}
		if opponent != nil {
			opponent.Send(ServerMessage{Type: "opponent_reconnected"})
		}
	}
	server.mu.Unlock()

	if expiredColor != game.Neutral {
		if state, err := session.game.Abandon(expiredColor); err == nil {
			server.finishSession(session, state)
		}
		client.Send(ServerMessage{
			Type:    "game_unavailable",
			Message: "that game is no longer available",
		})
		return
	}
	if oldClient != nil && oldClient != client {
		oldClient.close()
	}
	server.announceRoomOccupancy(rejoinedRoom)
}

func colorForUser(state game.GameState, userID string) game.PlayerColor {
	switch userID {
	case state.RedPlayer.UserID:
		return game.Red
	case state.BluePlayer.UserID:
		return game.Blue
	default:
		return game.Neutral
	}
}

func (server *Server) sendValidMoves(client *Client, from game.Position) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "valid_moves", From: &from, ValidMoves: []game.Position{}})
		return
	}
	moves := participant.session.game.ValidMoves(participant.color, from)
	client.Send(ServerMessage{Type: "valid_moves", From: &from, ValidMoves: moves})
}

// makeMove plays one move and reports whether the board accepted it.
//
// The return value exists for engines: a person sees move_rejected and tries
// again, while a bot needs the caller to notice and re-ask.
func (server *Server) makeMove(client *Client, from, to game.Position) bool {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "move_rejected", Message: "player is not in a game"})
		return false
	}

	state, err := participant.session.game.Move(participant.color, from, to)
	if err != nil {
		if state.Status == game.Finished {
			server.finishSession(participant.session, state)
			return false
		}
		client.Send(ServerMessage{Type: "move_rejected", Message: err.Error()})
		return false
	}
	// Before anything is broadcast: the escrow is over the instant a legal move
	// lands, and a sweep that ran between here and the broadcast would otherwise
	// call off a game that has just been played in.
	server.matchBegan(participant.session)
	if state.Status == game.Finished {
		server.finishSession(participant.session, state)
		return true
	}
	server.broadcastGameState(participant.session, state)
	return true
}

func (server *Server) offerDraw(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.OfferDraw(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.broadcastGameState(participant.session, state)
}

func (server *Server) acceptDraw(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.AcceptDraw(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.finishSession(participant.session, state)
}

func (server *Server) declineDraw(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.DeclineDraw(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.broadcastGameState(participant.session, state)
}

func (server *Server) offerTimeExtension(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.OfferTimeExtension(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.broadcastGameState(participant.session, state)
}

func (server *Server) acceptTimeExtension(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.AcceptTimeExtension(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.broadcastGameState(participant.session, state)
}

func (server *Server) declineTimeExtension(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.DeclineTimeExtension(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.broadcastGameState(participant.session, state)
}

func (server *Server) resign(client *Client) {
	participant := server.participantFor(client)
	if participant == nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: "player is not in a game"})
		return
	}
	state, err := participant.session.game.Resign(participant.color)
	if err != nil {
		client.Send(ServerMessage{Type: "action_rejected", Message: err.Error()})
		return
	}
	server.finishSession(participant.session, state)
}

// matchSetup describes everything about a new game that is *not* part of what
// the players agreed to play. What the game is — mode, clock, board, rules,
// whether it is rated — travels with the seats as their GameSetup, so ranked
// matchmaking, challenges, tournament rounds and bot games share one
// session-creation path and one source of truth for each of those answers.
type matchSetup struct {
	tournament *tournamentMatchRef
	botMatch   *botMatchRef
	// openingSeed names the seed the opening came from, for the archive.
	openingSeed string
	// openingMoves are played into the game before either player is told it
	// has started. They have to be applied here rather than by the caller:
	// this function sends match_found with a board snapshot, so a caller
	// replaying the opening afterwards would leave both engines searching a
	// position that is already out of date.
	openingMoves []game.Move
	// start opens the game with both clocks stopped, because the two people it
	// was made for may not be at it yet, and holds the seeks to put them back on
	// if the game never begins. Matchmaking and accepted challenges set it; a
	// tournament round and a bot game do not, because a ready-up and a pipe both
	// already prove somebody is there.
	start *matchStart
	// chat puts the new game into a conversation that already exists rather
	// than opening one of its own. Two things use it. Every game of a bot
	// series shares the run's room, so the talk carries across the boards and
	// the people who have not followed to the new one yet are still in it;
	// every match of a bots-only tournament shares the event's, so the crowd
	// watching one board can hear the crowd watching the next.
	chat *chatRoom
}

func (server *Server) startConfiguredMatch(
	first QueueEntry,
	second QueueEntry,
	setup matchSetup,
) *GameSession {
	// Either seat may be empty, so every message this function sends goes
	// through here. A seat with nobody in it is told nothing and is not an
	// error: they are being notified, and connection_ready hands them the game.
	tell := func(message ServerMessage) {
		if first.Client != nil {
			first.Client.Send(message)
		}
		if second.Client != nil {
			second.Client.Send(message)
		}
	}
	// The backstop for a server on its way out, and the reason this function is
	// worth having as a single choke point: matchmaking, an accepted challenge,
	// a tournament round and a challenge to an engine all pass through here,
	// and each of them already treats a nil session as "could not be arranged"
	// and puts back whatever it was holding. Every one of those paths also
	// refuses earlier, where it can say something more useful than this; a game
	// that reaches here during a drain is a race, not a route.
	//
	// The exception is the next game of a bot series, and it is not a loophole:
	// a run in progress is a commitment the drain is already *waiting on*, and
	// playNextSeriesGame has already applied the only policy a drain has about
	// series — finish the pair, then stop. Refusing here instead would abort the
	// run halfway through a pair, which is the exact outcome that rule exists to
	// prevent. Nothing else can arrive with a botMatch set: a new series is
	// refused in StartBotSeries.
	if server.isUpdating() && setup.botMatch == nil {
		tell(ServerMessage{Type: "error", Message: server.updateRefusalMessage()})
		return nil
	}
	gameID, err := randomID()
	if err != nil {
		tell(ServerMessage{Type: "error", Message: "could not create game"})
		return nil
	}
	// The first seat's setup decides the game. Both seats hold the same one:
	// pairing only puts together seeks whose setups fit, and every other caller
	// builds both seats from a single value.
	newGame, err := game.NewGameFromSetupWithStart(
		server.registry,
		gameID,
		first.Setup,
		first.profile(),
		second.profile(),
		game.StartOptions{ClockStartsOnFirstMove: setup.start != nil},
	)
	if err != nil {
		tell(ServerMessage{Type: "error", Message: err.Error()})
		return nil
	}

	for index, movement := range setup.openingMoves {
		state := newGame.Snapshot()
		if _, err := newGame.Move(state.CurrentTurn, movement.From, movement.To); err != nil {
			tell(ServerMessage{
				Type:    "error",
				Message: "could not play the opening move " + strconv.Itoa(index+1),
			})
			return nil
		}
	}

	server.leaveRoom(first.Client)
	server.leaveRoom(second.Client)

	// A game with no room named for it opens one of its own, under its own id,
	// so a conversation is always something a client can be told the name of.
	room := setup.chat
	if room == nil {
		room = newChatRoom(gameID)
	}
	// A seat nobody is holding starts its reconnect clock now, exactly as it
	// would if that player had dropped mid-game. Nothing acts on it while the
	// game is awaiting its first move — expireGames skips an unbegun game
	// entirely — and matchBegan re-anchors it to the move, so the absent player
	// gets a whole grace period from the moment the game became real rather
	// than whatever was left of one.
	seatedAt := time.Now()
	redAbsentSince, blueAbsentSince := time.Time{}, time.Time{}
	if first.Client == nil {
		redAbsentSince = seatedAt
	}
	if second.Client == nil {
		blueAbsentSince = seatedAt
	}
	session := &GameSession{
		gameID:             gameID,
		modeID:             first.Setup.ModeID,
		game:               newGame,
		redClient:          first.Client,
		blueClient:         second.Client,
		redDisconnectedAt:  redAbsentSince,
		blueDisconnectedAt: blueAbsentSince,
		redIsEngine:        first.Client.isBot(),
		blueIsEngine:       second.Client.isBot(),
		redElo:             first.Elo,
		blueElo:            second.Elo,
		spectators:         make(map[*Client]struct{}),
		chat:               room,
		startedAt:          seatedAt,
		ranked:             first.Setup.Ranked(),
		tournament:         setup.tournament,
		botMatch:           setup.botMatch,
		bookPlies:          len(setup.openingMoves),
		openingSeed:        setup.openingSeed,
		start:              setup.start,
	}
	server.mu.Lock()
	server.games[gameID] = session
	room.join(session)
	chatHistory := room.history()
	roomOccupancy := room.occupancy()
	if first.Client != nil {
		server.participants[first.Client] = Participant{session: session, color: game.Red}
	}
	if second.Client != nil {
		server.participants[second.Client] = Participant{session: session, color: game.Blue}
	}
	server.mu.Unlock()

	state := newGame.Snapshot()
	for _, seat := range []struct {
		client *Client
		color  game.PlayerColor
	}{{first.Client, game.Red}, {second.Client, game.Blue}} {
		if seat.client == nil || seat.client.isBot() {
			continue
		}
		seat.client.Send(ServerMessage{
			Type:      "match_found",
			Color:     seat.color,
			GameState: &state,
			// Almost always an empty movetext, and not always: a bot series
			// deals each pair its opening before either engine is asked to
			// move, so the first board a spectator or an owner sees can
			// already have moves behind it.
			PGN:                     livePGN(session),
			ChatMessages:            chatHistory,
			ChatRoomID:              room.id,
			ChatRoomScope:           room.scope,
			ChatOccupancy:           roomOccupancy,
			FirstMoveDeadlineUnixMs: setup.start.deadlineUnixMs(),
		})
	}
	server.broadcastModePlayerCounts()
	server.broadcastLiveGames()
	// The roster is derived from the participants written just above, so an
	// engine that has just been seated is only PLAYING in the lobby once this
	// has gone out. Here rather than at each caller: matchmaking, a challenge,
	// a tournament round and the next game of a series all seat engines.
	server.broadcastBotsForEngines(first.Client, second.Client)
	// A series changeover seats a new board in a room people are already in,
	// so the count they are looking at is this game's to restate.
	server.announceRoomOccupancy(room)
	// Every seating path funnels through here — matchmaking, challenges, bot
	// challenges, tournaments, series — so this is the one place a newly
	// seated engine needs to be told a game has begun. It is a no-op when
	// neither seat is a bot.
	server.beginBotGame(session)
	return session
}

func (server *Server) participantFor(client *Client) *Participant {
	server.mu.RLock()
	participant, ok := server.participants[client]
	server.mu.RUnlock()
	if !ok {
		return nil
	}
	return &participant
}

func (server *Server) spectatorFor(client *Client) *GameSession {
	server.mu.RLock()
	session := server.spectating[client]
	server.mu.RUnlock()
	return session
}

// broadcastQueueStatus keeps every live search ticking.
//
// It walks the board rather than the hub, which it has to now that a seek can
// exist without a socket: iterating connections would skip exactly the away
// searchers, and would send twice to somebody with two tabs. notifySeeker
// handles the fan-out, and writes nothing at all for a search whose author has
// gone — there is nowhere to write to, and their client will be told where
// things stand the moment it comes back.
func (server *Server) broadcastQueueStatus(now time.Time) {
	for _, seek := range server.seeks.All() {
		// Only a plain search gets a ticking update. Somebody who posted a game
		// already knows what they posted, and their row carries its own expiry.
		if !seek.Queued || seek.Client() == nil {
			continue
		}
		setup := seek.Setup
		server.notifySeeker(seek, ServerMessage{
			Type:        "queue_update",
			ModeID:      setup.ModeID,
			TimeControl: &setup.TimeControl,
			Setup:       &setup,
			SearchRange: seek.SearchRange(now),
			QueuedForMs: now.Sub(seek.JoinedAt).Milliseconds(),
		})
	}
	server.broadcastModePlayerCounts()
}

func (server *Server) modePlayerCounts() map[game.ModeID]int {
	counts := make(map[game.ModeID]int)
	for _, modeID := range server.registry.CatalogueIDs() {
		counts[modeID] = 0
	}
	for modeID, count := range server.seeks.CountsByMode() {
		counts[modeID] += count
	}

	server.mu.RLock()
	for _, session := range server.games {
		counts[session.modeID] += 2
	}
	server.mu.RUnlock()
	return counts
}

func (server *Server) liveGames() []LiveGameSummary {
	// Read outside the server lock: see botSeriesRunner.summaries.
	runs := server.botSeriesRuns.summaries()

	server.mu.RLock()
	liveGames := make([]LiveGameSummary, 0, len(server.games))
	for _, session := range server.games {
		state := session.game.Snapshot()
		startedAtUnixMs := int64(0)
		if !session.startedAt.IsZero() {
			startedAtUnixMs = session.startedAt.UnixMilli()
		}
		summary := LiveGameSummary{
			GameID:          session.gameID,
			ModeID:          state.Mode.ID,
			ModeName:        state.Mode.Name,
			RedPlayer:       state.RedPlayer,
			BluePlayer:      state.BluePlayer,
			RedElo:          session.redElo,
			BlueElo:         session.blueElo,
			SpectatorCount:  len(session.spectators),
			StartedAtUnixMs: startedAtUnixMs,
			Position:        liveGamePosition(state),
			CurrentTurn:     state.CurrentTurn,
			MoveNumber:      state.MoveNumber,
		}
		if session.botMatch != nil {
			if run, ok := runs[session.botMatch.seriesID]; ok {
				run.GameNumber = session.botMatch.gameNumber
				// Pair partners swap seats, so the odd-numbered game of each
				// pair is the one the first bot plays as Red.
				run.FirstIsRed = session.botMatch.gameNumber%2 == 1
				summary.Series = &run
			}
		}
		liveGames = append(liveGames, summary)
	}
	server.mu.RUnlock()
	sort.Slice(liveGames, func(first, second int) bool {
		if liveGames[first].StartedAtUnixMs == liveGames[second].StartedAtUnixMs {
			return liveGames[first].GameID < liveGames[second].GameID
		}
		return liveGames[first].StartedAtUnixMs > liveGames[second].StartedAtUnixMs
	})
	return liveGames
}

// liveGamePosition removes everything a lobby thumbnail does not draw. At 81
// squares this is a few short strings instead of a full grid whose JSON repeats
// x/y/occupant/owner field names for every tile.
//
// The pieces come from game.StartingPositionFrom rather than from a second
// RPSrps. table here: a thumbnail spelling a board differently from the mode
// definition beside it would be two alphabets with one name.
func liveGamePosition(state game.GameState) LiveGamePosition {
	owners := make([]string, 0, state.Grid.Height())
	for _, row := range state.Grid {
		symbols := make([]byte, len(row))
		for x, tile := range row {
			symbols[x] = '.'
			switch tile.OwnerColor {
			case game.Red:
				symbols[x] = 'r'
			case game.Blue:
				symbols[x] = 'b'
			}
		}
		owners = append(owners, string(symbols))
	}
	return LiveGamePosition{
		Rows:   game.StartingPositionFrom(state.Grid).Rows(),
		Owners: owners,
	}
}

// startBotSession records that a player is busy with a client-side bot. A
// repeat announcement replaces the previous one, which is how a reconnecting
// player restores their presence.
func (server *Server) startBotSession(client *Client, modeID game.ModeID) {
	server.mu.Lock()
	existing, alreadyPlaying := server.botSessions[client]
	if alreadyPlaying && existing.modeID == modeID {
		server.mu.Unlock()
		return
	}
	startedAt := existing.startedAt
	if !alreadyPlaying {
		startedAt = time.Now()
	}
	server.botSessions[client] = botSession{modeID: modeID, startedAt: startedAt}
	server.mu.Unlock()
	server.broadcastModePlayerCounts()
}

func (server *Server) endBotSession(client *Client) {
	server.mu.Lock()
	_, wasPlaying := server.botSessions[client]
	delete(server.botSessions, client)
	server.mu.Unlock()
	if wasPlaying {
		server.broadcastModePlayerCounts()
	}
}

// distinctPeople counts the people behind a set of connections.
//
// Presence is tracked per connection so that closing one tab cannot erase what
// the same account still has open elsewhere. Every counter the lobby publishes,
// though, promises a number of *people*, so reconnect overlap and multiple tabs
// for one account have to collapse to one.
func distinctPeople(clients []*Client) int {
	people := make(map[string]struct{}, len(clients))
	anonymousConnections := 0
	for _, client := range clients {
		select {
		case <-client.done:
			// writePump can discover a dead socket just before readPump reaches
			// disconnect. Do not expose that small cleanup window in the count.
			continue
		default:
		}
		if client.profile.UserID == "" {
			// Production browser clients are always authenticated and therefore
			// have an id. Keep id-less test/embedded clients distinct instead of
			// accidentally collapsing all of them into one player.
			anonymousConnections++
			continue
		}
		people[client.profile.UserID] = struct{}{}
	}
	return len(people) + anonymousConnections
}

func (server *Server) botPlayerCount() int {
	server.mu.RLock()
	clients := make([]*Client, 0, len(server.botSessions))
	for client := range server.botSessions {
		clients = append(clients, client)
	}
	server.mu.RUnlock()
	return distinctPeople(clients)
}

// onlineCount is how many people are connected, which is what the lobby's live
// rail means by "online". It counts humans only: lobbyClients already excludes
// engine connections, and an engine is not somebody who is here.
func (server *Server) onlineCount() int {
	return distinctPeople(server.lobbyClients())
}

func (server *Server) broadcastModePlayerCounts() {
	server.broadcastToClients(ServerMessage{
		Type:             "mode_player_counts",
		ModePlayerCounts: server.modePlayerCounts(),
		// Waiting players are broadcast separately from the total: a bot player
		// wants to know that someone is looking for a game right now, which the
		// combined figure cannot tell them.
		ModeQueueCounts: server.seeks.CountsByMode(),
		ModeReadyCounts: server.modeReadyCounts(),
		BotPlayerCount:  server.botPlayerCount(),
		OnlineCount:     server.onlineCount(),
	})
}

func (server *Server) broadcastLiveGames() {
	server.broadcastToClients(ServerMessage{
		Type:      "live_games",
		LiveGames: server.liveGames(),
	})
}

// broadcastToClients delivers one lobby-wide message to every connection.
// broadcastToClients publishes to every *person* in the lobby.
//
// Bots are excluded, and this is the single place that matters: a bot has no
// lobby, cannot read while its engine is thinking, and would be disconnected
// by the send buffer overflowing during a long search. Filtering here covers
// live games, mode counts, and tournaments at once. Challenge delivery
// deliberately still uses connectedClients, so bots stay challengeable.
func (server *Server) broadcastToClients(message ServerMessage) {
	for _, client := range server.lobbyClients() {
		client.Send(message)
	}
}

// lobbyClients is every connected human.
func (server *Server) lobbyClients() []*Client {
	clients := server.connectedClients()
	humans := clients[:0]
	for _, client := range clients {
		if !client.isBot() {
			humans = append(humans, client)
		}
	}
	return humans
}

func (server *Server) disconnect(client *Client) {
	server.unregisterBot(client)
	// A closing tab no longer ends an unbegun game, and that is the point of
	// the whole arrangement: the player who just closed it may be about to open
	// the notification. The thirty-second window is the only thing that calls a
	// game off by itself; anybody who knows they cannot play presses abort.
	server.releaseSeeksOnDisconnect(client, "The challenger disconnected.")
	now := time.Now()
	var disconnected *Participant
	wasSpectating := false
	// Every conversation this connection was part of, so each is told it has
	// one fewer person in it once the lock is back down.
	var emptied []*chatRoom
	server.mu.Lock()
	if session := server.spectating[client]; session != nil {
		delete(server.spectating, client)
		delete(session.spectators, client)
		emptied = append(emptied, session.chat)
		wasSpectating = true
	}
	if room := server.leaveRoomLocked(client); room != nil {
		emptied = append(emptied, room)
	}
	delete(server.botSessions, client)
	if participant, ok := server.participants[client]; ok {
		delete(server.participants, client)
		session := participant.session
		switch participant.color {
		case game.Red:
			if session.redClient == client {
				session.redClient = nil
				session.redDisconnectedAt = now
				disconnected = &participant
			}
		case game.Blue:
			if session.blueClient == client {
				session.blueClient = nil
				session.blueDisconnectedAt = now
				disconnected = &participant
			}
		}
		if disconnected != nil {
			emptied = append(emptied, session.chat)
		}
	}
	server.mu.Unlock()
	server.hub.Unregister(client)
	for _, room := range emptied {
		server.announceRoomOccupancy(room)
	}
	server.broadcastModePlayerCounts()
	if wasSpectating {
		server.broadcastLiveGames()
	}
	if server.clearTournamentReadiness(client) {
		server.broadcastTournaments()
	}

	if disconnected != nil {
		// Read from the session rather than added up here, so the countdown on
		// the opponent's screen is the deadline the sweep will actually act on
		// — including the two things that shorten it, an engine's seat and a
		// clock about to run out. See reconnectDeadline.
		//
		// Under the lock, because the timestamp it reads is one matchBegan and
		// a rejoin also write, and the snapshot comes first: server.mu before
		// the game lock is the order rejoinGame already takes them in.
		state := disconnected.session.game.Snapshot()
		server.mu.RLock()
		deadline := disconnected.session.reconnectDeadline(disconnected.color, state)
		server.mu.RUnlock()
		server.sendToColor(
			disconnected.session,
			game.OtherColor(disconnected.color),
			ServerMessage{
				Type:                    "opponent_disconnected",
				ReconnectDeadlineUnixMs: deadlineUnixMilli(deadline),
			},
		)
		// An engine that dropped mid-game has a seat being held for it, and it
		// is the one kind of player that cannot ask for it back: a bot has no
		// rejoin_game to send. The next connection it makes is what claims it.
		// See bot_resume.go.
		server.logEngineLeftGame(client, disconnected, deadline)
	}
}

// retireSession takes a finished game out of the lobby and hands whoever is
// still connected to it over to a chat room, so the conversation survives the
// result. Nobody is a player or spectator of a live game any more, which frees
// them to queue for another match while they talk.
func (server *Server) retireSession(session *GameSession) {
	server.mu.Lock()
	current, ok := server.games[session.gameID]
	if !ok || current != session {
		server.mu.Unlock()
		return
	}
	delete(server.games, session.gameID)

	members := 0
	seat := func(client *Client, color game.PlayerColor) {
		if client == nil {
			return
		}
		server.postGameMembers[client] = Participant{session: session, color: color}
		members++
	}
	for spectator := range session.spectators {
		if server.spectating[spectator] != session {
			continue
		}
		delete(server.spectating, spectator)
		seat(spectator, game.Neutral)
	}
	// Read under the lock, for the roster below: after the unlock these fields
	// belong to whoever holds it next.
	redClient, blueClient := session.redClient, session.blueClient
	for _, player := range []struct {
		client *Client
		color  game.PlayerColor
	}{
		{redClient, game.Red},
		{blueClient, game.Blue},
	} {
		if player.client == nil ||
			server.participants[player.client].session != session {
			continue
		}
		delete(server.participants, player.client)
		seat(player.client, player.color)
	}
	if members > 0 {
		server.postGameRooms[session.gameID] = session
	} else {
		// Nobody stayed behind, so this board is not part of the conversation
		// any more. Leaving it in would keep a finished game reachable through
		// the room its series shares.
		session.chat.leave(session)
	}
	server.mu.Unlock()

	server.broadcastModePlayerCounts()
	server.broadcastLiveGames()
	// An engine that was in this game has a slot back, and the badge beside its
	// name is the roster's to correct. Every finished, expired and abandoned
	// game funnels through here.
	server.broadcastBotsForEngines(redClient, blueClient)
	// The room is the same room and the people in it are the same people, but
	// the lobby row this game had is gone. Restating the count here is what
	// keeps a client that was reading it off that row from losing it at the
	// result.
	server.announceRoomOccupancy(session.chat)
}

func (server *Server) expireGames(now time.Time) {
	server.mu.RLock()
	sessions := make([]*GameSession, 0, len(server.games))
	for _, session := range server.games {
		sessions = append(sessions, session)
	}
	server.mu.RUnlock()

	for _, session := range sessions {
		// A game awaiting its first move has both clocks stopped and neither
		// player yet obliged to be at it. expireUnstartedGames owns it until
		// somebody moves; touching it here would rule a player to have abandoned
		// a game that has not started.
		if session.game.AwaitingFirstMove() {
			continue
		}
		state, expired := session.game.Tick(now)
		if expired {
			server.finishSession(session, state)
			continue
		}
		if abandoned := server.abandonedPlayer(session, state, now); abandoned != game.Neutral {
			state, err := session.game.Abandon(abandoned)
			if err == nil {
				server.finishSession(session, state)
			}
		}
	}
	server.removeExpiredCompletedGames(now)
}

func (server *Server) removeExpiredCompletedGames(now time.Time) {
	server.mu.Lock()
	for gameID, completed := range server.completedGames {
		if !now.Before(completed.expiresAt) {
			delete(server.completedGames, gameID)
		}
	}
	server.mu.Unlock()
}

func (server *Server) broadcastGameState(session *GameSession, state game.GameState) {
	// Written once for the whole audience, and only when there is one. A
	// bot-versus-bot game with nobody watching is most of what the series
	// runner plays, and encoding the entire game again on every move of it
	// would be work for no reader. See ServerMessage.PGN.
	audience := server.sessionAudience(session)
	if len(audience) > 0 {
		message := ServerMessage{
			Type:      "game_state",
			GameState: &state,
			PGN:       livePGN(session),
		}
		for _, client := range audience {
			client.Send(message)
		}
	}
	// Every change to a game funnels through here, which makes it the one
	// place a bot needs to be asked for its move. Prompting is idempotent:
	// it does nothing when it is the other side's turn, and nothing when the
	// engine is already thinking about this position.
	server.promptBot(session, state)
	// The lobby's featured board is a live view too. Publish its compact
	// position after every state change so a spectator can follow the game
	// before deciding to enter the room.
	server.broadcastLiveGames()
}

// sessionAudience is everybody attached to this game who reads board
// snapshots: whoever is playing it, and whoever is watching.
//
// A bot is sent RPSI lines instead, so it is left out. That keeps the largest
// message in the protocol — a 9x9 grid with territory, several kilobytes of
// JSON — off connections that would only discard it, and it is what lets the
// caller ask whether writing the message is worth doing at all.
func (server *Server) sessionAudience(session *GameSession) []*Client {
	server.mu.RLock()
	defer server.mu.RUnlock()
	redClient := session.redClient
	blueClient := session.blueClient
	audience := make([]*Client, 0, len(session.spectators)+2)
	if redClient != nil && !redClient.isBot() {
		audience = append(audience, redClient)
	}
	if blueClient != nil && blueClient != redClient && !blueClient.isBot() {
		audience = append(audience, blueClient)
	}
	for spectator := range session.spectators {
		if spectator != redClient && spectator != blueClient {
			audience = append(audience, spectator)
		}
	}
	return audience
}

func (server *Server) broadcastToSession(session *GameSession, message ServerMessage) {
	for _, client := range server.sessionAudience(session) {
		client.Send(message)
	}
}

func (server *Server) sendToColor(
	session *GameSession,
	color game.PlayerColor,
	message ServerMessage,
) {
	server.mu.RLock()
	var client *Client
	if color == game.Red {
		client = session.redClient
	} else if color == game.Blue {
		client = session.blueClient
	}
	server.mu.RUnlock()
	if client != nil {
		client.Send(message)
	}
}

func (server *Server) abandonedPlayer(
	session *GameSession,
	state game.GameState,
	now time.Time,
) game.PlayerColor {
	server.mu.RLock()
	defer server.mu.RUnlock()
	if current, ok := server.games[session.gameID]; !ok || current != session {
		return game.Neutral
	}
	redDeadline := session.reconnectDeadline(game.Red, state)
	blueDeadline := session.reconnectDeadline(game.Blue, state)
	redExpired := !redDeadline.IsZero() && !now.Before(redDeadline)
	blueExpired := !blueDeadline.IsZero() && !now.Before(blueDeadline)
	switch {
	case redExpired && blueExpired:
		if redDeadline.Before(blueDeadline) {
			return game.Red
		}
		if blueDeadline.Before(redDeadline) {
			return game.Blue
		}
		return game.Red
	case redExpired:
		return game.Red
	case blueExpired:
		return game.Blue
	default:
		return game.Neutral
	}
}

// reconnectDeadline is the moment an empty seat stops being held.
//
// Two things shorten it. Whose seat it is: an engine gets
// botReconnectGracePeriod rather than the half minute a person gets. And the
// clock: a side that walked away on its own move is spending time it does not
// have, so waiting past the flag would be holding a seat in a game that is
// already decided. Which of the two ends it is not this function's business —
// expireGames reads the clock first, so a game that reaches zero is recorded
// as a loss on time and never as an abandonment.
//
// state is the position as of now, and is only read for the clock. Passing it
// in rather than snapshotting here keeps the sweep to one read of the game per
// tick, which is also the read that advanced the clock in the first place.
func (session *GameSession) reconnectDeadline(
	color game.PlayerColor,
	state game.GameState,
) time.Time {
	disconnectedAt := session.redDisconnectedAt
	isEngine := session.redIsEngine
	if color == game.Blue {
		disconnectedAt = session.blueDisconnectedAt
		isEngine = session.blueIsEngine
	}
	if disconnectedAt.IsZero() {
		return time.Time{}
	}
	grace := reconnectGracePeriod
	if isEngine {
		grace = botReconnectGracePeriod
	}
	deadline := disconnectedAt.Add(grace)

	// Only the side to move is spending anything, so only that side has an end
	// of time to run into. A game still waiting for its first move has a clock
	// that is not running yet, and expireGames does not look at those at all.
	if state.Status != game.InProgress || state.CurrentTurn != color {
		return deadline
	}
	remaining := state.Clock.RedRemainingMs
	if color == game.Blue {
		remaining = state.Clock.BlueRemainingMs
	}
	flagsAt := clockUpdatedAt(state).Add(time.Duration(remaining) * time.Millisecond)
	if flagsAt.Before(deadline) {
		return flagsAt
	}
	return deadline
}

// clockUpdatedAt is the instant the published clock was last advanced to,
// which is what the remaining milliseconds beside it are measured from.
func clockUpdatedAt(state game.GameState) time.Time {
	return time.UnixMilli(state.Clock.UpdatedAtUnixMs)
}

func deadlineUnixMilli(deadline time.Time) int64 {
	if deadline.IsZero() {
		return 0
	}
	return deadline.UnixMilli()
}

func (server *Server) finishSession(session *GameSession, state game.GameState) {
	session.closeOnce.Do(func() {
		// Before anything that can take a moment. This game is over, so the
		// questions it asked its engines are void, and the next game in a
		// series is seated shortly after this function returns.
		server.retireBotExchanges(session)
		finishedAt := time.Now()
		ratingUpdate, err := server.data.RecordCompletedGame(
			context.Background(),
			state,
			session.startedAt,
			finishedAt,
			session.ranked,
		)
		if err != nil {
			log.Printf("persist completed game %s: %v", session.gameID, err)
		}
		if err == nil {
			server.updateSessionAccounts(session, ratingUpdate)
			// A ranked game between two engines refits the whole mode's ladder,
			// so every other engine on the roster is now publishing a rating
			// from before it.
			if ratingUpdate.Ranked &&
				session.redClient.isBot() && session.blueClient.isBot() {
				server.republishBotLadder(context.Background(), ratingUpdate.ModeID)
			}
		}
		// Archived after the rating transaction so the stored game can name
		// the ratings it produced, but never gated on it: every finished game
		// is written down.
		server.archiveGame(session, finishedAt, ratingUpdate, err == nil)
		server.mu.Lock()
		server.completedGames[session.gameID] = CompletedGame{
			state:     state,
			expiresAt: finishedAt.Add(completedGameRetention),
		}
		server.mu.Unlock()
		message := ServerMessage{
			Type:      "game_state",
			GameState: &state,
			// The whole game, on the message that says it is over. This is
			// what the result card and the move list read from, and the last
			// chance to send it: the session is retired a few lines below and
			// its record goes with it.
			PGN: livePGN(session),
		}
		if err == nil {
			message.RatingUpdate = &ratingUpdate
		}
		server.broadcastToSession(session, message)
		server.retireSession(session)
		server.recordTournamentMatchResult(session, state)
		server.recordBotMatchResult(session, state)
		// Last, so the ladder refit and the tournament standing this game may
		// have just decided are both already written down. Both players, and
		// through them the owner of either engine that was playing.
		server.awardTitles(
			context.Background(),
			state.RedPlayer.UserID,
			state.BluePlayer.UserID,
		)
		// Last of all, and only ever a no-op unless a deploy is waiting on this
		// game. The lobby ticker would find it within two seconds; asking here
		// is what makes the restart follow the final move rather than the next
		// tick. Note the ordering: recordBotMatchResult above has already
		// marked the series as advancing, so a run mid-pair is still counted.
		server.settleUpdateDrain()
	})
}

func (server *Server) updateSessionAccounts(
	session *GameSession,
	update persistence.RatingUpdate,
) {
	server.mu.Lock()
	defer server.mu.Unlock()
	if session.redClient != nil {
		session.redClient.account.RecordRatedGame(update.ModeID, update.RedEloAfter)
	}
	if session.blueClient != nil {
		session.blueClient.account.RecordRatedGame(update.ModeID, update.BlueEloAfter)
	}
}

// republishBotLadder brings every connected engine's cached rating back in line
// with the ladder, and restates the roster so the lobby is reading the same one.
//
// updateSessionAccounts above is enough for a per-game system, where a result
// moves exactly the two accounts that earned it. The bot ladder is not one: it
// is a fit over every pair's record, so a single game restates the whole mode
// and there is nothing in one result to patch the other engines from. Without
// this, every engine that was not in the game keeps publishing whatever it was
// rated when it connected — which for a bot that connects once and plays all day
// is the seed it started from, and never its rating.
//
// Called for ranked engine-versus-engine games and after an administrator
// deletes something that refits, which are the two things that move the ladder.
// Variadic because a game moves the one mode it was played in and a deletion can
// move all of them, and either way the roster wants restating once at the end.
func (server *Server) republishBotLadder(ctx context.Context, modes ...game.ModeID) {
	for _, modeID := range modes {
		ratings, err := server.data.BotModeRatings(ctx, modeID)
		if err != nil {
			// Worth saying, not worth failing over: what moved the ladder is
			// already written down, and the next thing that moves it will
			// restate the roster.
			log.Printf("refresh bot ladder for %s: %v", modeID, err)
			continue
		}
		server.mu.Lock()
		for _, connections := range server.bots {
			for _, client := range connections {
				rating, found := ratings[client.account.UserID]
				if !found {
					// A bot with no rating row in this mode has never finished
					// a ranked game in it, so there is nothing to correct.
					// Writing DefaultElo here would invent a mode rating the
					// database does not have, and ModeElo already answers for a
					// mode with none.
					continue
				}
				client.account.SetModeElo(modeID, rating)
			}
		}
		server.mu.Unlock()
	}
	server.broadcastBots()
}

// ratedModeIDs is every mode an engine can hold a rating in: what a refit that
// did not name a mode may have moved.
func (server *Server) ratedModeIDs() []game.ModeID {
	definitions := server.registry.Definitions()
	modes := make([]game.ModeID, 0, len(definitions))
	for _, definition := range definitions {
		modes = append(modes, definition.ID)
	}
	return modes
}

func randomID() (string, error) {
	data := make([]byte, 12)
	if _, err := rand.Read(data); err != nil {
		return "", fmt.Errorf("random id: %w", err)
	}
	return hex.EncodeToString(data), nil
}

func originChecker(allowed []string) func(*http.Request) bool {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, origin := range allowed {
		if trimmed := strings.TrimSpace(origin); trimmed != "" {
			allowedSet[trimmed] = struct{}{}
		}
	}
	return func(request *http.Request) bool {
		origin := request.Header.Get("Origin")
		if origin == "" {
			return true // Native clients generally do not send an Origin header.
		}
		if _, ok := allowedSet[origin]; ok {
			return true
		}
		parsed, err := url.Parse(origin)
		if err != nil {
			return false
		}
		hostname := parsed.Hostname()
		if hostname == "localhost" {
			return true
		}
		ip := net.ParseIP(hostname)
		return ip != nil && (ip.IsLoopback() || ip.IsPrivate())
	}
}
