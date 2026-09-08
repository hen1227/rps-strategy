// Command vapidkeys prints a fresh VAPID key pair for RPS_VAPID_PUBLIC_KEY and
// RPS_VAPID_PRIVATE_KEY.
//
// It exists so that turning on notifications is one command rather than a
// half-remembered openssl incantation. The keys identify this server to the
// browsers' push services; rotating them invalidates every stored subscription,
// which the server then prunes on the first 404 it gets back.
package main

import (
	"fmt"
	"os"

	webpush "github.com/SherClockHolmes/webpush-go"
)

func main() {
	privateKey, publicKey, err := webpush.GenerateVAPIDKeys()
	if err != nil {
		fmt.Fprintf(os.Stderr, "generate VAPID keys: %v\n", err)
		os.Exit(1)
	}
	fmt.Printf("RPS_VAPID_PUBLIC_KEY=%s\n", publicKey)
	fmt.Printf("RPS_VAPID_PRIVATE_KEY=%s\n", privateKey)
	fmt.Println("RPS_VAPID_SUBJECT=mailto:you@example.com")
}
