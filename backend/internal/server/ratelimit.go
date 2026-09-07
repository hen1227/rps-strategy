package server

import (
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// A small in-memory rate limiter, for the two routes that need one.
//
// There was none anywhere in the backend before this, which was survivable
// while every credential was a 256-bit random string nobody would try to
// guess. Passwords change that: they are guessable, and each verification
// costs most of a second of CPU on the deployment hardware. That makes the
// login route both a credential-stuffing target and a denial-of-service lever
// against the game loop, which shares its single SQLite connection.
//
// Two buckets per attempt, deliberately. Per-IP stops one host hammering the
// endpoint; per-username stops a distributed attempt at one account. Either
// alone leaves the other open.
//
// Starting a bot series is throttled by the same mechanism for an unrelated
// reason, described at seriesAttemptBurst below.

const (
	authAttemptBurst  = 8
	authAttemptWindow = time.Minute
	// Starting a bot series is the second thing here worth throttling, for a
	// different reason: it is cheap to ask for and expensive to serve, and since
	// it stopped being an administrator's command anybody can ask. The
	// concurrency ceiling in bot_series.go already bounds how many runs exist at
	// once; this bounds how fast somebody can rattle the door, including the
	// requests that are refused and so never occupy a slot.
	seriesAttemptBurst  = 6
	seriesAttemptWindow = 5 * time.Minute
	// Proposing a name for an opening is the third: a write anybody can make
	// that everybody then reads, which is the combination spam likes. The
	// ceiling is generous enough that naming a whole afternoon's worth of lines
	// never touches it.
	openingNameBurst  = 20
	openingNameWindow = 10 * time.Minute

	// rateLimiterCapacity bounds memory. An attacker rotating through a /64 of
	// IPv6 could otherwise make the map itself the attack.
	rateLimiterCapacity = 4096
)

type rateBucket struct {
	tokens   float64
	lastSeen time.Time
}

// rateLimiter is a token bucket per key, refilling at burst/window.
type rateLimiter struct {
	mu      sync.Mutex
	buckets map[string]*rateBucket
	burst   float64
	window  time.Duration
	now     func() time.Time
}

func newRateLimiter(burst int, window time.Duration) *rateLimiter {
	return &rateLimiter{
		buckets: make(map[string]*rateBucket),
		burst:   float64(burst),
		window:  window,
		now:     time.Now,
	}
}

// Allow spends a token, reporting whether one was available and how long until
// the next one is.
func (limiter *rateLimiter) Allow(key string) (bool, time.Duration) {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	now := limiter.now()

	bucket, found := limiter.buckets[key]
	if !found {
		if len(limiter.buckets) >= rateLimiterCapacity {
			limiter.evictLocked(now)
		}
		bucket = &rateBucket{tokens: limiter.burst, lastSeen: now}
		limiter.buckets[key] = bucket
	}

	refill := now.Sub(bucket.lastSeen).Seconds() / limiter.window.Seconds() * limiter.burst
	bucket.tokens = min(bucket.tokens+refill, limiter.burst)
	bucket.lastSeen = now

	if bucket.tokens < 1 {
		perToken := limiter.window.Seconds() / limiter.burst
		wait := time.Duration((1 - bucket.tokens) * perToken * float64(time.Second))
		return false, wait
	}
	bucket.tokens--
	return true, 0
}

// evictLocked drops the least recently used half. Crude, and correct for the
// purpose: the worst case is that a few honest callers get a fresh allowance.
func (limiter *rateLimiter) evictLocked(now time.Time) {
	oldest := now
	for _, bucket := range limiter.buckets {
		if bucket.lastSeen.Before(oldest) {
			oldest = bucket.lastSeen
		}
	}
	cutoff := oldest.Add(now.Sub(oldest) / 2)
	for key, bucket := range limiter.buckets {
		if bucket.lastSeen.Before(cutoff) {
			delete(limiter.buckets, key)
		}
	}
}

// sweep drops buckets that have fully refilled and so hold no information.
func (limiter *rateLimiter) sweep() {
	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	now := limiter.now()
	for key, bucket := range limiter.buckets {
		if now.Sub(bucket.lastSeen) > limiter.window*2 {
			delete(limiter.buckets, key)
		}
	}
}

// allowAuthAttempt applies both buckets and writes a 429 itself when refused.
func (server *Server) allowAuthAttempt(
	writer http.ResponseWriter,
	request *http.Request,
	username string,
) bool {
	for _, key := range []string{
		"ip:" + clientIP(request),
		"user:" + strings.ToLower(strings.TrimSpace(username)),
	} {
		if allowed, wait := server.authLimiter.Allow(key); !allowed {
			writer.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
			writeAPIError(writer, http.StatusTooManyRequests, "too many attempts; try again shortly")
			return false
		}
	}
	return true
}

// allowOAuthStart throttles beginning a Discord sign-in, per IP only.
//
// Per IP and not also per account, unlike allowAuthAttempt next door, because
// there is no account yet — that is the whole point of the route. The thing
// being protected is different too: /start verifies no credential, so what it
// can be abused for is filling the pending-flow map rather than guessing a
// password.
func (server *Server) allowOAuthStart(
	writer http.ResponseWriter,
	request *http.Request,
) bool {
	if allowed, wait := server.authLimiter.Allow("oauth-ip:" + clientIP(request)); !allowed {
		writer.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeAPIError(writer, http.StatusTooManyRequests, "too many attempts; try again shortly")
		return false
	}
	return true
}

// allowSeriesRequest throttles asking for a bot series, writing the 429 itself.
//
// Per account and per IP, for the same reason the auth routes use both: a Guest
// account costs nothing to mint, so the account bucket alone would be a
// formality, and one IP can hold many honest accounts, so the IP bucket alone
// would punish a shared network harder than it needs to.
func (server *Server) allowSeriesRequest(
	writer http.ResponseWriter,
	request *http.Request,
	userID string,
) bool {
	for _, key := range []string{
		"series-ip:" + clientIP(request),
		"series-user:" + strings.TrimSpace(userID),
	} {
		if allowed, wait := server.seriesLimiter.Allow(key); !allowed {
			writer.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
			writeAPIError(
				writer,
				http.StatusTooManyRequests,
				"too many series requests; try again shortly",
			)
			return false
		}
	}
	return true
}

// allowOpeningSuggestion throttles proposing a name, writing the 429 itself.
//
// Per IP alone, unlike the other two. A name suggestion needs no account, so
// there is no second identity to bucket on -- and bucketing on the line would
// punish the opening everybody wants to name rather than the person naming it
// forty times.
func (server *Server) allowOpeningSuggestion(
	writer http.ResponseWriter,
	request *http.Request,
) bool {
	allowed, wait := server.openingNameLimiter.Allow("opening-ip:" + clientIP(request))
	if !allowed {
		writer.Header().Set("Retry-After", strconv.Itoa(int(wait.Seconds())+1))
		writeAPIError(
			writer,
			http.StatusTooManyRequests,
			"too many name suggestions; try again shortly",
		)
	}
	return allowed
}

// clientIP identifies the caller for rate-limiting purposes.
//
// In production the only ingress is an nginx unix socket, so RemoteAddr is
// meaningless and the forwarded headers are the truth. On a plain TCP listener
// those same headers are attacker-controlled, so they are consulted only when
// RemoteAddr cannot be a real remote peer — which is exactly the case behind
// the socket, and never the case on a directly exposed port.
func clientIP(request *http.Request) string {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		host = request.RemoteAddr
	}
	address := net.ParseIP(host)
	trustForwarded := address == nil || address.IsLoopback()
	if trustForwarded {
		if forwarded := strings.TrimSpace(request.Header.Get("X-Real-IP")); forwarded != "" {
			host = forwarded
		} else if forwarded := request.Header.Get("X-Forwarded-For"); forwarded != "" {
			host = strings.TrimSpace(strings.Split(forwarded, ",")[0])
		}
	}
	// Bucket IPv6 by /64: a single customer is routinely handed that much
	// space, so treating each address separately would give one attacker
	// billions of allowances.
	if parsed := net.ParseIP(host); parsed != nil && parsed.To4() == nil {
		return parsed.Mask(net.CIDRMask(64, 128)).String()
	}
	return host
}
