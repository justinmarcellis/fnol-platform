import assert from 'node:assert/strict';
import {
  NotImplemented, requireImplemented, assertEvent, compareExpected, FRAUD_THRESHOLD,
  createApi, listTenants, scenarioList, scenarioAppliesTo, runStep,
} from './harness.mjs';

/**
 * Lifecycle steps. Each is { name, module, event, run(env) }.
 * env = { ctx, tenantId, api, scenario, state }. Steps throw NotImplemented for missing modules/endpoints.
 * `state` accumulates claimId and produced data (`actual`) for scenario.expected comparisons.
 * Event names come from architecture/contracts/events.
 */

function needModule(env, module) {
  if (env.ctx.modules?.[module] === undefined) throw new NotImplemented(`ctx.modules.${module} is not defined (module not built yet)`);
}
function needClaim(env) {
  if (!env.state.claimId) throw new NotImplemented('no claim was created (report step not implemented)');
}

async function afterStep(env, event) {
  await env.ctx.bus.drain();
  assertEvent(env.ctx, env.tenantId, env.state.claimId, event);
}

export const STEPS = [
  {
    name: 'report',
    module: 'claims',
    event: 'claim.reported',
    async run(env) {
      needModule(env, 'claims');
      const res = requireImplemented(await env.api('POST', '/claims', { body: env.scenario.claimCreate }), 'POST /claims');
      assert.equal(res.status, 201, `POST /claims: ${res.text}`);
      assert.ok(res.json?.id, 'claim has an id');
      env.state.claimId = res.json.id;
      await afterStep(env, 'claim.reported');
    },
  },
  {
    name: 'upload documents',
    module: 'evidence',
    event: 'claim.evidence.added',
    async run(env) {
      needClaim(env);
      needModule(env, 'evidence');
      const docs = env.scenario.documents ?? [];
      if (docs.length === 0) throw new NotImplemented('scenario has no documents');
      for (const d of docs) {
        const body = { kind: d.kind, filename: d.filename, contentType: d.contentType, contentBase64: d.contentBase64 ?? Buffer.from(d.bytes ?? d.text ?? d.content ?? '').toString('base64') };
        const res = requireImplemented(await env.api('POST', `/claims/${env.state.claimId}/documents`, { body }), 'POST /claims/{id}/documents');
        assert.equal(res.status, 201, `upload: ${res.text}`);
      }
      await afterStep(env, 'claim.evidence.added');
    },
  },
  {
    name: 'coverage',
    module: 'coverage',
    event: 'claim.coverage.verified',
    async run(env) {
      needClaim(env);
      needModule(env, 'coverage');
      // claim.reported triggers verification automatically; fall back to an explicit call.
      await env.ctx.bus.drain();
      let res = requireImplemented(await env.api('GET', `/claims/${env.state.claimId}/coverage`), 'GET /claims/{id}/coverage');
      if (res.status !== 200) {
        res = requireImplemented(await env.api('POST', `/claims/${env.state.claimId}/coverage/verify`), 'POST /claims/{id}/coverage/verify');
      }
      assert.ok([200, 201].includes(res.status), `coverage: ${res.text}`);
      env.state.actual.coverageStatus = res.json?.outcome;
      await afterStep(env, 'claim.coverage.verified');
      compareExpected(env.scenario.expected, { coverageStatus: env.state.actual.coverageStatus });
    },
  },
  {
    name: 'triage',
    module: 'triage',
    event: 'claim.triaged',
    async run(env) {
      needClaim(env);
      needModule(env, 'triage');
      await env.ctx.bus.drain();
      let res = requireImplemented(await env.api('GET', `/claims/${env.state.claimId}/triage`), 'GET /claims/{id}/triage');
      if (res.status !== 200) {
        res = requireImplemented(await env.api('POST', `/claims/${env.state.claimId}/triage`, { body: {}, role: 'adjuster' }), 'POST /claims/{id}/triage');
      }
      assert.ok([200, 201].includes(res.status), `triage: ${res.text}`);
      const t = res.json ?? {};
      Object.assign(env.state.actual, {
        severityBand: t.severityBand,
        fraud: typeof t.fraud?.score === 'number' ? t.fraud.score >= FRAUD_THRESHOLD : undefined,
        subrogation: t.subrogation?.flag,
      });
      await afterStep(env, 'claim.triaged');
      compareExpected(env.scenario.expected, env.state.actual);
    },
  },
  {
    name: 'routing / STP',
    module: 'rules',
    event: 'claim.routed',
    async run(env) {
      needClaim(env);
      needModule(env, 'rules');
      await env.ctx.bus.drain();
      let res = requireImplemented(await env.api('GET', `/claims/${env.state.claimId}/routing`), 'GET /claims/{id}/routing');
      if (res.status !== 200) {
        res = requireImplemented(await env.api('POST', `/claims/${env.state.claimId}/routing`, { body: {}, role: 'adjuster' }), 'POST /claims/{id}/routing');
      }
      assert.ok([200, 201].includes(res.status), `routing: ${res.text}`);
      env.state.actual.fastTrack = res.json?.fastTrack;
      await afterStep(env, 'claim.routed');
      compareExpected(env.scenario.expected, { fastTrack: env.state.actual.fastTrack });
    },
  },
  {
    name: 'adjuster first view',
    module: 'adjuster',
    event: 'claim.routed',
    async run(env) {
      needClaim(env);
      needModule(env, 'adjuster');
      const res = requireImplemented(await env.api('GET', `/adjuster/claims/${env.state.claimId}/view`, { role: 'adjuster' }), 'GET /adjuster/claims/{id}/view');
      assert.equal(res.status, 200, `adjuster view: ${res.text}`);
      assert.equal(res.json?.claim?.id, env.state.claimId, 'view is for this claim');
      // The read model has no event of its own; it is built from claim.routed.
      await afterStep(env, 'claim.routed');
      const t = res.json.triage ?? {};
      compareExpected(env.scenario.expected, {
        coverageStatus: res.json.coverage?.outcome,
        severityBand: t.severityBand,
        fastTrack: res.json.routing?.fastTrack,
      });
    },
  },
];

const SEED = 'e2e-s1';

/**
 * Run the scenario x tenant x step matrix as nested subtests.
 * @param {import('node:test').TestContext} t
 * @param {{h: {app:any, ctx:any}, synthetic: any, tenants?: Array<{id:string, config:object}>}} opts
 */
export async function runMatrix(t, { h, synthetic, tenants = listTenants() }) {
  if (tenants.length === 0) return t.todo('no tenants in tenants/*.json yet; scenario matrix cannot run');
  const scenarios = scenarioList(synthetic.SCENARIOS);

  for (const tenant of tenants) {
    for (const entry of scenarios) {
      if (!scenarioAppliesTo(tenant.config, entry.lob)) continue;
      await t.test(`${tenant.id} / ${entry.name}`, async (st) => {
        let scenario;
        try {
          scenario = synthetic.generateScenario(entry.name, { seed: SEED, tenantId: tenant.id });
        } catch (err) {
          return st.todo(`generateScenario(${entry.name}) failed: ${err.message}`);
        }
        const env = { ctx: h.ctx, tenantId: tenant.id, api: createApi(h.app, tenant.id), scenario, state: { actual: {} } };

        // Seed policies when coverage provides a seeding hook; coverage steps degrade to todo otherwise.
        const tctx = h.ctx.forTenant(tenant.id);
        const seed = tctx.modules?.coverage?.seedPolicies;
        if (typeof seed === 'function') {
          const policies = [...(scenario.policy ? [scenario.policy] : []), ...synthetic.generatePolicies({ tenantId: tenant.id, lob: entry.lob, count: 5, seed: SEED })];
          await seed.call(tctx.modules.coverage, policies);
        }

        // Report the claim on the scenario's own reported date, so report lag (a fraud cue) is the scenario's,
        // not the gap between a synthetic loss date and the wall clock. Restored after the scenario.
        const reportedDate = scenario.meta?.reportedDate;
        if (reportedDate && typeof h.ctx.clock?.set === 'function') h.ctx.clock.set(`${reportedDate}T15:00:00.000Z`);
        try {
          for (const step of STEPS) {
            await st.test(step.name, (s) => runStep(s, () => step.run(env)));
          }
        } finally {
          if (reportedDate && typeof h.ctx.clock?.reset === 'function') h.ctx.clock.reset();
        }
      });
    }
  }
}
