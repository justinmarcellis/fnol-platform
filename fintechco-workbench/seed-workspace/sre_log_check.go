package main

import (
	"log"
	"net/http"
	"time"
)

// probeGateway is the SRE health check for the card authorization gateway.
func probeGateway(url string, testCard string) {
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		log.Printf("gateway probe failed card=%s err=%v", testCard, err)
		return
	}
	defer resp.Body.Close()
	log.Printf("gateway probe ok status=%d card=%s", resp.StatusCode, testCard)
}

func main() {
	probeGateway("https://auth-gw.internal.fintechco.com/healthz", "4111222233334444")
}
