package server

import (
	"log"
	"os"
	"strconv"
	"strings"

	"rps-strategy/backend/internal/botclient"
)

// Which app builds may still play here.
//
// The website is whatever was deployed last, but a phone keeps the build it
// installed until its owner updates it, and the server goes on changing
// without it. Most changes are written so that old builds keep working. When
// one cannot be — a message renamed, a rule the phone checks for itself
// changed — this is how to say so: raise that platform's minimum, and an
// older build is told to update instead of failing in some way nobody can
// diagnose from a phone.
//
// Nothing is refused until a minimum is set. The website never is: a page is
// fixed by reloading it, and a build too old to say what it is (every one
// before 1.0) is never refused either, because there is no version to compare.

const (
	appPlatformIOS     = "ios"
	appPlatformAndroid = "android"

	// The Play listing is named by the application id, so it is known before
	// the app is published. The App Store's address carries a number Apple
	// assigns, which is why iOS has no default and is set alongside its
	// minimum instead.
	defaultAndroidStoreURL = "https://play.google.com/store/apps/details?id=com.henhen1227.rpsstrategy"

	updateRequiredMessage = "This version of RPS Strategy is too old to play online. Update it to keep playing."
)

type appVersionGate struct {
	// minimum is the oldest version each platform may connect with, by the
	// platform names the app sends. A platform with no entry is never refused.
	minimum map[string]string
	// storeURL is where an older build is sent to update.
	storeURL map[string]string
}

// newAppVersionGate reads the minimums from the environment. A minimum that
// is not a version is refused and named at boot, like every other setting
// here, rather than discovered as a gate that never closes.
func newAppVersionGate() appVersionGate {
	gate := appVersionGate{
		minimum: map[string]string{},
		storeURL: map[string]string{
			appPlatformAndroid: defaultAndroidStoreURL,
		},
	}
	for platform, variable := range map[string]string{
		appPlatformIOS:     "RPS_IOS_STORE_URL",
		appPlatformAndroid: "RPS_ANDROID_STORE_URL",
	} {
		if address := strings.TrimSpace(os.Getenv(variable)); address != "" {
			gate.storeURL[platform] = address
		}
	}
	for platform, variable := range map[string]string{
		appPlatformIOS:     "RPS_MIN_APP_VERSION_IOS",
		appPlatformAndroid: "RPS_MIN_APP_VERSION_ANDROID",
	} {
		minimum := strings.TrimSpace(os.Getenv(variable))
		switch {
		case minimum == "":
		case !isAppVersion(minimum):
			log.Printf("app version check disabled for %s: %s=%q is not a version like 1.2.0", platform, variable, minimum)
		default:
			gate.minimum[platform] = minimum
			if gate.storeURL[platform] == "" {
				log.Printf("%s builds older than %s will be sent to the website: no store address is set", platform, minimum)
			}
		}
	}
	return gate
}

// refusal is what an `authenticate` from a build too old for this server is
// answered with, and false for every build that may play.
func (gate appVersionGate) refusal(platform, version string) (ServerMessage, bool) {
	minimum := gate.minimum[strings.ToLower(strings.TrimSpace(platform))]
	version = strings.TrimSpace(version)
	if minimum == "" || !isAppVersion(version) {
		return ServerMessage{}, false
	}
	if botclient.CompareVersions(version, minimum) >= 0 {
		return ServerMessage{}, false
	}
	return ServerMessage{
		Type:     "update_required",
		Message:  updateRequiredMessage,
		StoreURL: gate.storeURL[strings.ToLower(strings.TrimSpace(platform))],
	}, true
}

// isAppVersion reports whether a version is dotted numbers, as app.json's is.
func isAppVersion(version string) bool {
	if version == "" {
		return false
	}
	for _, field := range strings.Split(version, ".") {
		if _, err := strconv.Atoi(field); err != nil {
			return false
		}
	}
	return true
}
