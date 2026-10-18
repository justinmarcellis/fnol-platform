// Claude on Vertex AI. SDK is imported lazily; absence or missing GOOGLE_CLOUD_PROJECT => unavailable.
import { SYSTEM_PROMPT, buildPrompt, envelopeSchema, parseEnvelope, projectFrom } from './_shared.mjs';

export const TIER_MODELS = Object.freeze({
  cheap: 'claude-haiku-5-5', fast: 'claude-haiku-5-5',
  mid: 'claude-sonnet-5-5', standard: 'claude-sonnet-5-5',
  strong: 'claude-opus-5-5',
});

/**
 * @param {object} ctx
 * @param {{sdk?: {AnthropicVertex?: Function, client?: object}, env?: object, projectId?: string, maxTokens?: number}} [opts]
 */
export default function createVertexClaude(ctx, opts = {}) {
  const env = opts.env ?? process.env;
  let clientP;

  async function getClient() {
    clientP ??= (async () => {
      try {
        if (opts.sdk?.client) return opts.sdk.client;
        const Ctor = opts.sdk?.AnthropicVertex ?? (await import('@anthropic-ai/vertex-sdk')).AnthropicVertex;
        const projectId = projectFrom(env, opts);
        if (!Ctor || !projectId) return null;
        return new Ctor({ projectId, region: 'global' });
      } catch { return null; }
    })();
    return clientP;
  }

  return {
    name: 'vertex-claude',
    async available() {
      try { return !!projectFrom(env, opts) && !!(await getClient()); } catch { return false; }
    },
    async run(task, input, { tier = 'cheap', schema, model } = {}) {
      try {
        const client = await getClient();
        if (!client) return { refusal: true, error: 'unavailable' };
        const useModel = model && model.startsWith('claude-') ? model : TIER_MODELS[tier] ?? TIER_MODELS.cheap;
        const res = await client.messages.create({
          model: useModel,
          max_tokens: opts.maxTokens ?? 8192,
          system: SYSTEM_PROMPT,
          thinking: { type: 'adaptive' },
          output_config: { format: { type: 'json_schema', schema: envelopeSchema(schema) } },
          messages: [{ role: 'user', content: buildPrompt(task, input) }],
        });
        if (res?.stop_reason === 'refusal') return { refusal: true };
        const text = (res?.content ?? []).filter((b) => b?.type === 'text').map((b) => b.text).join('');
        const parsed = parseEnvelope(text);
        return {
          ...parsed,
          usage: { inputTokens: res.usage?.input_tokens ?? 0, outputTokens: res.usage?.output_tokens ?? 0 },
          model: res.model ?? useModel,
        };
      } catch (e) {
        ctx?.log?.debug?.('vertex-claude failed', { error: String(e?.message ?? e).slice(0, 160) });
        return { refusal: true, error: String(e?.message ?? e).slice(0, 160) };
      }
    },
  };
}
