const cds = require("@sap/cds");

module.exports = class CatalogService extends cds.ApplicationService {
  init() {
    const { Books, Orders } = this.entities;

    this.on("topBooks", async (req) => {
      const n = Math.max(1, Math.min(50, Number(req.data.n) || 5));
      return SELECT.from(Books).orderBy("stock desc").limit(n);
    });

    this.on("restock", Books, async (req) => {
      const { ID } = req.params[0] ?? {};
      const amount = Number(req.data.amount) || 0;
      await UPDATE(Books, ID).with({ stock: { "+=": amount } });
      return SELECT.one.from(Books, ID);
    });

    this.on("submitOrder", async (req) => {
      const ID = req.data.order;
      await UPDATE(Orders, ID).with({ placedAt: new Date().toISOString() });
      return SELECT.one.from(Orders, ID);
    });

    return super.init();
  }
};
