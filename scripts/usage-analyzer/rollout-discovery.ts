import { Database } from "bun:sqlite";
import { join } from "node:path";

const rolloutIdPattern =
  /([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i;
const stateDatabasePattern = /state_(\d+)\.sqlite$/;

export function rolloutId(path: string): string | undefined {
  return rolloutIdPattern.exec(path)?.[1];
}

export async function listRollouts(codexHome: string): Promise<string[]> {
  const candidates: string[] = [];
  for (const root of [
    join(codexHome, "sessions"),
    join(codexHome, "archived_sessions"),
  ]) {
    try {
      for await (const relative of new Bun.Glob("**/*.jsonl").scan({
        cwd: root,
        onlyFiles: true,
      })) {
        candidates.push(join(root, relative));
      }
    } catch {
      // A fresh Codex home may not have both directories yet.
    }
  }
  const byId = new Map<string, { path: string; size: number }>();
  for (const path of candidates) {
    const id = rolloutId(path) ?? path;
    const size = Bun.file(path).size;
    const existing = byId.get(id);
    if (!existing || size > existing.size) byId.set(id, { path, size });
  }
  return [...byId.values()].map(({ path }) => path).sort();
}

function databaseSequence(path: string): number {
  return Number(stateDatabasePattern.exec(path)?.[1] ?? 0);
}

export function loadTitles(codexHome: string): Map<string, string> {
  const titles = new Map<string, string>();
  try {
    const databases = [
      ...new Bun.Glob("state_*.sqlite").scanSync({
        cwd: codexHome,
        onlyFiles: true,
      }),
    ].sort((left, right) => databaseSequence(right) - databaseSequence(left));
    const newest = databases[0];
    if (!newest) return titles;
    const database = new Database(join(codexHome, newest), { readonly: true });
    try {
      const query = database.query<{ id: string; title: string }, []>(
        "SELECT id, title FROM threads",
      );
      for (const row of query.all()) {
        if (typeof row.id === "string" && typeof row.title === "string") {
          titles.set(row.id, row.title);
        }
      }
    } finally {
      database.close();
    }
  } catch {
    // Rollout analysis works without Desktop's optional title index.
  }
  return titles;
}
