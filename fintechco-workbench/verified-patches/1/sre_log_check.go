package main

import (
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"time"
)

var logger = slog.New(slog.NewJSONHandler(os.Stdout, nil))

var nonDigit = regexp.MustCompile(`\D`)

// maskPAN keeps only the last 4 digits visible (CLAUDE.md Rule 1, PCI-DSS 3.4).
func maskPAN(card string) string {
	digits := nonDigit.ReplaceAllString(card, "")
	if len(digits) < 4 {
		return "XXXX"
	}
	return "XXXX-XXXX-XXXX-" + digits[len(digits)-4:]
}

// probeGateway is the SRE health check for the card authorization gateway.
func probeGateway(url string, testCard string) {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		logger.Error("gateway_probe_failed", "pan", maskPAN(testCard), "err", err)
		return
	}
	defer resp.Body.Close()
	logger.Info("gateway_probe_ok", "status", resp.StatusCode, "pan", maskPAN(testCard))
}

func main() {
	probeGateway("https://auth-gw.internal.fintechco.com/healthz", "4111222233334444")
}
