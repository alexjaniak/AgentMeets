import { readFileSync } from "node:fs";
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from "pg";

export interface PgQueryable {
  query<R extends QueryResultRow = QueryResultRow>(text: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
}

export type PgTransactionClient = PoolClient;

export function readDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const value = env.DATABASE_URL?.trim();
  if (!value) {
    throw new Error("DATABASE_URL is required");
  }
  return value;
}

export function createPgPool(connectionString: string = readDatabaseUrl()): Pool {
  const config = buildPoolConfig(connectionString);
  return new Pool(config);
}

export async function withPgTransaction<T>(
  pool: Pool,
  fn: (client: PgTransactionClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function buildPoolConfig(connectionString: string): PoolConfig {
  const url = new URL(connectionString);
  const sslmode = url.searchParams.get("sslmode");
  const sslrootcert = url.searchParams.get("sslrootcert");

  if (!sslmode && !sslrootcert) {
    return { connectionString };
  }

  const rejectUnauthorized = sslmode === "verify-full" || sslmode === "verify-ca";
  const ca = sslrootcert ? readFileSync(sslrootcert, "utf8") : undefined;

  return {
    connectionString,
    ssl: {
      rejectUnauthorized,
      ...(ca ? { ca } : {}),
    },
  };
}
