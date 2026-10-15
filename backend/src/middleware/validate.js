const { badRequest } = require('../errors');

/**
 * validate({ body, query, params }) ด้วย zod
 * ผลลัพธ์ที่ผ่านการ parse แล้วอยู่ใน req.valid.{body,query,params}
 */
function validate(schemas) {
  return (req, _res, next) => {
    req.valid = req.valid || {};
    for (const key of ['params', 'query', 'body']) {
      if (!schemas[key]) continue;
      const r = schemas[key].safeParse(req[key] ?? {});
      if (!r.success) {
        throw badRequest('ข้อมูลไม่ถูกต้อง', r.error.issues.map((i) => ({ path: [key, ...i.path].join('.'), message: i.message })));
      }
      req.valid[key] = r.data;
    }
    next();
  };
}

module.exports = { validate };
