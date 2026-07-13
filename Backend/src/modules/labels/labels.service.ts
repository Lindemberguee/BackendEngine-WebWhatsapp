import { Types } from 'mongoose';
import { Label, Conversation, Contact } from '../../db/models';

/**
 * Curated, modern default palette (Linear/Notion-style). Used to auto-assign a
 * color when a label is created inline (e.g. applying a brand-new tag) without
 * the user explicitly choosing one.
 */
export const LABEL_PALETTE = [
  '#EF4444', '#F97316', '#F59E0B', '#EAB308',
  '#84CC16', '#10B981', '#14B8A6', '#06B6D4',
  '#3B82F6', '#6366F1', '#8B5CF6', '#A855F7',
  '#EC4899', '#F43F5E', '#64748B', '#78716C',
];

/** Deterministic palette pick from a name so the same tag gets a stable color. */
export function colorForName(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return LABEL_PALETTE[hash % LABEL_PALETTE.length];
}

/**
 * Ensure a label with the given name exists in the workspace catalog, creating it
 * with an auto-assigned color if missing. Idempotent and race-safe (relies on the
 * unique index). Returns nothing — callers only need the name to persist on docs.
 */
export async function ensureLabel(workspaceId: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    await Label.updateOne(
      { workspaceId: new Types.ObjectId(workspaceId), name: trimmed },
      { $setOnInsert: { color: colorForName(trimmed) } },
      { upsert: true, collation: { locale: 'pt', strength: 2 } }
    );
  } catch (err) {
    // Duplicate-key from the race where two upserts insert at once — safe to ignore.
    if ((err as { code?: number }).code !== 11000) throw err;
  }
}

/** Count how many conversations + contacts currently use each label name. */
export async function usageCounts(workspaceId: string, names: string[]): Promise<Record<string, number>> {
  const wsId = new Types.ObjectId(workspaceId);
  const [convAgg, contactAgg] = await Promise.all([
    Conversation.aggregate<{ _id: string; n: number }>([
      { $match: { workspaceId: wsId, tags: { $in: names } } },
      { $unwind: '$tags' },
      { $match: { tags: { $in: names } } },
      { $group: { _id: '$tags', n: { $sum: 1 } } },
    ]),
    Contact.aggregate<{ _id: string; n: number }>([
      { $match: { workspaceId: wsId, tags: { $in: names } } },
      { $unwind: '$tags' },
      { $match: { tags: { $in: names } } },
      { $group: { _id: '$tags', n: { $sum: 1 } } },
    ]),
  ]);
  const counts: Record<string, number> = {};
  for (const name of names) counts[name] = 0;
  for (const r of convAgg) counts[r._id] = (counts[r._id] ?? 0) + r.n;
  for (const r of contactAgg) counts[r._id] = (counts[r._id] ?? 0) + r.n;
  return counts;
}
