import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import type { D1Database, D1PreparedStatement, D1Result } from "@cloudflare/workers-types";

export class MockD1Database {
  private db: DatabaseSync;

  constructor(inMemory = true) {
    this.db = new DatabaseSync(inMemory ? ":memory:" : "test.db");
  }

  public applyMigrations(migrationsDir = path.resolve(__dirname, "../../migrations")): void {
    const files = fs.readdirSync(migrationsDir).sort();
    for (const file of files) {
      if (file.endsWith(".sql") && !file.includes("seed")) {
        const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
        this.db.exec(sql);
      }
    }
  }

  public applySeed(seedPath = path.resolve(__dirname, "../../migrations/seed.sql")): void {
    if (fs.existsSync(seedPath)) {
      const sql = fs.readFileSync(seedPath, "utf8");
      this.db.exec(sql);
    }
  }

  public prepare(query: string): D1PreparedStatement {
    const db = this.db;
    let boundValues: unknown[] = [];

    const stmtObj: D1PreparedStatement = {
      bind(...values: unknown[]) {
        boundValues = values;
        return stmtObj;
      },
      async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
        const statement = db.prepare(query);
        const row = statement.get(...(boundValues as (string | number | bigint | null)[])) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (colName) return (row[colName] as T) ?? null;
        return row as T;
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const statement = db.prepare(query);
        const rows = statement.all(...(boundValues as (string | number | bigint | null)[])) as T[];
        return {
          results: rows,
          success: true,
          meta: {} as D1Result<T>["meta"]
        };
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const statement = db.prepare(query);
        const res = statement.run(...(boundValues as (string | number | bigint | null)[]));
        return {
          results: [],
          success: true,
          meta: {
            changes: Number(res.changes),
            last_row_id: Number(res.lastInsertRowid)
          } as D1Result<T>["meta"]
        };
      },
      // @ts-expect-error Mock implementation
      async raw<T = unknown[]>(_options?: { columnNames?: boolean }): Promise<T[]> {
        const statement = db.prepare(query);
        const rows = statement.all(...(boundValues as (string | number | bigint | null)[]));
        return rows.map((r) => Object.values(r as Record<string, unknown>)) as T[];
      }
    };

    return stmtObj;
  }

  public async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.db.exec("BEGIN TRANSACTION");
    try {
      const results: D1Result<T>[] = [];
      for (const stmt of statements) {
        results.push(await stmt.run<T>());
      }
      this.db.exec("COMMIT");
      return results;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  public async exec(query: string): Promise<D1Result<unknown>> {
    this.db.exec(query);
    return {
      results: [],
      success: true,
      meta: {} as D1Result<unknown>["meta"]
    };
  }

  public asD1(): D1Database {
    return this as unknown as D1Database;
  }
}
