// OpenAPI contract for POST /v1/payments/score (generated from ds_fraud_notebook.py).
// Consumed by the TypeScript checkout service; the Java ledger service generates
// the matching record from the same OpenAPI document.

export type Decision = "APPROVE" | "REVIEW" | "DECLINE";

export interface ScoreRequest {
  amount: number; // >= 0, USD
  velocity_24h: number; // >= 0, integer
  is_foreign_ip: boolean;
}

export interface ScoreResponse {
  risk_score: number; // 0.0 - 1.0
  decision: Decision;
  model_version: string;
}

export async function scorePayment(baseUrl: string, req: ScoreRequest): Promise<ScoreResponse> {
  const res = await fetch(`${baseUrl}/v1/payments/score`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`fraud scoring failed: ${res.status}`);
  return (await res.json()) as ScoreResponse;
}
