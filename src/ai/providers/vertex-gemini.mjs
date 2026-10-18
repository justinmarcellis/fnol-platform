// Gemini on Vertex AI via @google/genai. SDK imported lazily; unavailable (never throws) when absent.
import { SYSTEM_PROMPT, buildPrompt, envelopeSchema, parseEnvelope, projectFrom, locationFrom } from './_shared.mjs';

export const TIER_MODELS = Object.freeze({
  cheap: 'gemini-2.5-flash', fast: 'gemini-2.5-flash',
  mid: 'gemini-2.5-flash', standard: 'gemini-2.5-flash',
  strong: 'gemini-2.5-pro',
});

/** Convert a sanitised JSON schema to the Gemini responseSchema dialect (upper-case types, no additionalProperties). */
export function toGeminiSchema(s) {
  if (Array.isArray(s)) return s.map(toGeminiSchema);
  if (!s || typeof s !== 'object') return s;
  if (s.anyOf) return { type: 'STRING', description: 'scalar value; arrays are JSON-encoded strings' };
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (k === 'additionalProperties') continue;
    if (k === 'type') out.type = Array.isArray(v) ? String(v.find((t) => t !== 'null') ?? 'string').toUpperCase() : String(v).toUpperCase();
    else if (k === 'properties') out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    else if (k === 'items') out.items = toGeminiSchema(v);
    else out[k] = v;
  }
  return out;
}

export default function createVertexGemini(ctx, opts = {}) {
  const env = opts.env ?? process.env;
  let clientP;

  async function getClient() {
    clientP ??= (async () => {
      try {
        if (opts.sdk?.client) return opts.sdk.client;
        const Ctor = opts.sdk?.GoogleGenAI ?? (await import('@google/genai')).GoogleGenAI;
        const project = projectFrom(env, opts);
        if (!Ctor || !project) return null;
        return new Ctor({ vertexai: true, project, location: locationFrom(env, opts) });
      } catch { return null; }
    })();
    return clientP;
  }

  return {
    name: 'vertex-gemini',
    async available() {
      try { return !!projectFrom(env, opts) && !!(await getClient()); } catch { return false; }
    },
    async run(task, input, { tier = 'cheap', schema, model } = {}) {
      try {
        const client = await getClient();
        if (!client) return { refusal: true, error: 'unavailable' };
        const useModel = model && model.startsWith('gemini-') ? model : TIER_MODELS[tier] ?? TIER_MODELS.cheap;
        const res = await client.models.generateContent({
          model: useModel,
          contents: buildPrompt(task, input),
          config: {
            systemInstruction: SYSTEM_PROMPT,
            responseMimeType: 'application/json',
            responseSchema: toGeminiSchema(envelopeSchema(schema)),
          },
        });
        const cand = res?.candidates?.[0];
        if (res?.promptFeedback?.blockReason || cand?.finishReason === 'SAFETY' || cand?.finishReason === 'PROHIBITED_CONTENT') return { refusal: true };
        const text = typeof res?.text === 'string' ? res.text : (cand?.content?.parts ?? []).map((p) => p.text ?? '').join('');
        const parsed = parseEnvelope(text);
        const u = res.usageMetadata ?? {};
        return { ...parsed, usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0 }, model: res.modelVersion ?? useModel };
      } catch (e) {
        ctx?.log?.debug?.('vertex-gemini failed', { error: String(e?.message ?? e).slice(0, 160) });
        return { refusal: true, error: String(e?.message ?? e).slice(0, 160) };
      }
    },
  };
}
