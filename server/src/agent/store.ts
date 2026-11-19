/** Run persistence helpers: leases, step log, checkpoints, messages. */
import { and, eq, sql } from "drizzle-orm";
import { toTsvectorLiteral } from "../lib/textsearch";
import type { Part, RunStatus, StoredMessageDTO } from "../../../shared/src/index";
import type { Database } from "../db/client";
import { conversations, messages, runs } from "../db/schema";

export type RunRow = typeof runs.$inferSelect;

export interface PendingTools {
  calls: Extract<Part, { type: "tool_call" }>[];
  /** callId → result (filled as tools finish / are denied). */
  results: Record<string, { result: unknown; isError?: boolean }>;
  /** callId → JSON parse error of the model's arguments. */
  argErrors?: Record<string, string>;
}

export interface RunOptions {
  reasoning?: { effort?: "minimal" | "low" | "medium" | "high"; budgetTokens?: number };
  maxTokens?: number;
  temperature?: number;
}

export interface Checkpoint {
  /** Last message of this run's chain (the next model step continues from here). */
  leafId: string;
  pending?: PendingTools;
  options?: RunOptions;
  finishReason?: string;
  /** Spend-cap warning (80 %) already recorded for this run. */
  spendWarned?: boolean;
}

/** A segment that has not heartbeated for this long is considered dead and its run can be re-claimed. */
export const STALE_LEASE_MS = 75_000;

/** Atomically take the run lease. Returns the row when claimed. */
export async function claimRun(database: Database, runId: string, staleMs = STALE_LEASE_MS): Promise<RunRow | undefined> {
  const rows = await database.query<Record<string, unknown>>(
    `UPDATE runs SET status = 'running', updated_at = now()
       WHERE id = $1 AND (status IN ('pending', 'paused')
         OR (status = 'running' AND updated_at < now() - ($2::int * interval '1 millisecond')))
     RETURNING id`,
    [runId, staleMs],
  );
  if (!rows.length) return undefined;
  return getRun(database, runId);
}

export async function getRun(database: Database, runId: string): Promise<RunRow | undefined> {
  const [r] = await database.db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  return r;
}

/** Heartbeat; returns the current status (lets a segment notice a stop request from another instance). */
export async function heartbeat(database: Database, runId: string): Promise<RunStatus | undefined> {
  const rows = await database.query<{ status: RunStatus }>(`UPDATE runs SET updated_at = now() WHERE id = $1 RETURNING status`, [runId]);
  return rows[0]?.status;
}

/** Append to the run's step log with a DB-assigned sequence number (safe with concurrent writers). */
export async function appendStep(database: Database, runId: string, kind: string, payload: unknown): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    try {
      const rows = await database.query<{ seq: number }>(
        `INSERT INTO run_steps (run_id, seq, kind, payload)
         SELECT $1, coalesce(max(seq), 0) + 1, $2, $3::jsonb FROM run_steps WHERE run_id = $1
         RETURNING seq`,
        [runId, kind, JSON.stringify(payload ?? null)],
      );
      return rows[0].seq;
    } catch (e) {
      if ((e as { code?: string }).code === "23505" && attempt < 5) continue;
      throw e;
    }
  }
}

export async function saveRun(database: Database, runId: string, patch: Partial<typeof runs.$inferInsert>) {
  await database.db.update(runs).set({ ...patch, updatedAt: new Date() }).where(eq(runs.id, runId));
}

/** Conditional status transition (e.g. only from 'running'). Returns whether it applied. */
export async function transition(database: Database, runId: string, from: RunStatus[], patch: Partial<typeof runs.$inferInsert>): Promise<boolean> {
  for (const f of from) {
    const r = await database.db.update(runs).set({ ...patch, updatedAt: new Date() }).where(and(eq(runs.id, runId), eq(runs.status, f))).returning({ id: runs.id });
    if (r.length) return true;
  }
  return false;
}

export function searchTextOf(parts: Part[]): string {
  return parts
    .flatMap((p) => (p.type === "text" ? [p.text] : p.type === "file" ? [p.name] : []))
    .join("\n")
    .slice(0, 20000);
}

export function toMessageDTO(r: typeof messages.$inferSelect): StoredMessageDTO {
  return { id: r.id, parentId: r.parentId, role: r.role as StoredMessageDTO["role"], parts: r.parts, runId: r.runId, createdAt: r.createdAt.toISOString() };
}

export async function insertMessage(
  database: Database,
  m: { conversationId: string; parentId: string | null; role: string; parts: Part[]; runId?: string | null; modelId?: string | null },
) {
  const searchText = searchTextOf(m.parts);
  const [row] = await database.db
    .insert(messages)
    .values({ conversationId: m.conversationId, parentId: m.parentId, role: m.role, parts: m.parts, runId: m.runId ?? null, modelId: m.modelId ?? null, searchText, searchTsv: sql`${toTsvectorLiteral(searchText)}::tsvector` as unknown as string })
    .returning();
  await database.db.update(conversations).set({ activeLeafId: row.id, updatedAt: new Date() }).where(eq(conversations.id, m.conversationId));
  return row;
}
