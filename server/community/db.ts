import pg from "pg";
import fs from "node:fs/promises";
export interface Database {
  query<T = any>(
    sql: string,
    values?: any[],
  ): Promise<{ rows: T[]; rowCount?: number | null }>;
  transaction<T>(run: (db: Database) => Promise<T>): Promise<T>;
}
let pool: pg.Pool | undefined;
export function postgres(): Database {
  if (!process.env.DATABASE_URL)
    throw Object.assign(new Error("Community ще не підключено до PostgreSQL"), {
      status: 503,
    });
  pool ??= new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 4000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: "h00k-community",
  });
  const wrap = (client: pg.Pool | pg.PoolClient): Database => ({
    query: (sql, values) => client.query(sql, values),
    transaction: async (run) => {
      const session = await pool!.connect();
      try {
        await session.query("BEGIN");
        const result = await run(wrap(session));
        await session.query("COMMIT");
        return result;
      } catch (error) {
        await session.query("ROLLBACK");
        throw error;
      } finally {
        session.release();
      }
    },
  });
  return wrap(pool);
}
export async function migrate(db: Database) {
  const source = await fs.readFile(
    new URL("./schema.sql", import.meta.url),
    "utf8",
  );
  await db.transaction(async (tx) => {
    for (const statement of source
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean))
      await tx.query(statement);
  });
}
export async function closeDatabase() {
  await pool?.end();
  pool = undefined;
}
