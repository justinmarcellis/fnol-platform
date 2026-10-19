export default {
  name: 'health',
  routes(router, ctx) {
    router.get('/healthz', (req, res) => {
      res.json(200, { ok: true, modules: ctx.moduleNames, tenants: ctx.tenants.list().length });
    }, { public: true });
  },
};
