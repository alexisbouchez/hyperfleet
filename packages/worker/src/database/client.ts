import {
  Kysely,
  SqliteAdapter,
  SqliteIntrospector,
  SqliteQueryCompiler,
  CompiledQuery,
  type DatabaseConnection,
  type Driver,
  type Dialect,
  type QueryResult,
} from "kysely";
import { Database as BunSQLite, type SQLQueryBindings } from "bun:sqlite";
import type { Database } from "./schema";

export interface DatabaseConfig {
  /** Path to the SQLite database file */
  filename: string;
}

/**
 * Custom Kysely driver for Bun's native SQLite
 */
class BunSqliteDriver implements Driver {
  private db: BunSQLite;

  constructor(config: DatabaseConfig) {
    this.db = new BunSQLite(config.filename);
  }

  async init(): Promise<void> {}

  async acquireConnection(): Promise<DatabaseConnection> {
    return new BunSqliteConnection(this.db);
  }

  async beginTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("BEGIN"));
  }

  async commitTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("COMMIT"));
  }

  async rollbackTransaction(connection: DatabaseConnection): Promise<void> {
    await connection.executeQuery(CompiledQuery.raw("ROLLBACK"));
  }

  async releaseConnection(): Promise<void> {}

  async destroy(): Promise<void> {
    this.db.close();
  }
}

/**
 * Connection implementation for Bun SQLite
 */
class BunSqliteConnection implements DatabaseConnection {
  private db: BunSQLite;

  constructor(db: BunSQLite) {
    this.db = db;
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const sql = query.sql;
    const params = query.parameters as readonly SQLQueryBindings[];

    // Use query() for SELECT statements (returns rows)
    // Use run() for other statements (returns changes info)
    const isSelect = sql.trimStart().toUpperCase().startsWith("SELECT");

    if (isSelect) {
      const stmt = this.db.query(sql);
      const rows = stmt.all(...params) as R[];
      return { rows };
    }

    const stmt = this.db.query(sql);
    const result = stmt.run(...params);
    return {
      rows: [],
      numAffectedRows: BigInt(result.changes),
      insertId: result.lastInsertRowid !== undefined
        ? BigInt(result.lastInsertRowid)
        : undefined,
    };
  }

  streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("Streaming is not supported by Bun SQLite driver");
  }
}

/**
 * Kysely dialect for Bun's native SQLite
 */
class BunSqliteDialect implements Dialect {
  private config: DatabaseConfig;

  constructor(config: DatabaseConfig) {
    this.config = config;
  }

  createAdapter() {
    return new SqliteAdapter();
  }

  createDriver() {
    return new BunSqliteDriver(this.config);
  }

  createIntrospector(db: Kysely<unknown>) {
    return new SqliteIntrospector(db);
  }

  createQueryCompiler() {
    return new SqliteQueryCompiler();
  }
}

/**
 * Create a new Kysely database instance configured for Bun's native SQLite
 */
export function createDatabase(config: DatabaseConfig): Kysely<Database> {
  return new Kysely<Database>({
    dialect: new BunSqliteDialect(config),
  });
}

/**
 * Create an in-memory database (useful for testing)
 */
export function createInMemoryDatabase(): Kysely<Database> {
  return createDatabase({ filename: ":memory:" });
}
