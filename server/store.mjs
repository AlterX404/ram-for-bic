export function database(binding) {
  function statement(sql, ...values) {
    return binding.prepare(sql).bind(...values);
  }
  return {
    statement,
    one: (sql, ...values) => statement(sql, ...values).first(),
    async all(sql, ...values) {
      return (await statement(sql, ...values).all()).results;
    },
    async run(sql, ...values) {
      return (await statement(sql, ...values).run()).meta.changes;
    },
    batch: (statements) => binding.batch(statements),
  };
}
