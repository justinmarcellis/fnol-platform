// GET /api/v1/kpis?from&to (read-only).
export const KPI_ROLES = ['supervisor', 'tenant_admin', 'carrier_admin', 'auditor'];

export function registerRoutes(router) {
  router.get('/api/v1/kpis', async (req, res) => {
    const { from, to } = req.query ?? {};
    res.json(200, await req.ctx.modules.kpi.compute({ from, to }));
  }, { roles: KPI_ROLES });
}
