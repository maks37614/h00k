import type { Database } from "../../server/community/db";
/** Real PostgreSQL statements, including nested savepoints, on the embedded test connection. */
export function testDatabase(engine: any): Database {
  let next = 0;
  const wrap = (client: any, nested = false): Database => ({
    query: (sql, values) => client.query(sql, values),
    transaction: async (run) => {
      if (!nested) return engine.transaction((tx: any) => run(wrap(tx, true)));
      const name = "fixture_savepoint_" + ++next;
      await client.query("SAVEPOINT " + name);
      try {
        const result = await run(wrap(client, true));
        await client.query("RELEASE SAVEPOINT " + name);
        return result;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT " + name);
        await client.query("RELEASE SAVEPOINT " + name);
        throw error;
      }
    },
  });
  return wrap(engine);
}
