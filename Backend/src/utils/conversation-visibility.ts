/**
 * Agents/viewers only see conversations assigned to them or still unassigned
 * (the queue) — owners/admins see everything. Mirrors the rule already
 * applied to GET /api/conversations (list) in conversations.routes.ts, now
 * reused for every single-conversation lookup across conversations.routes.ts
 * and messages.routes.ts, which previously only scoped by workspaceId.
 */
export function scopeConversationFilter(
  filter: Record<string, unknown>,
  actor: { role: string; sub: string }
): Record<string, unknown> {
  if (actor.role !== 'agent' && actor.role !== 'viewer') return filter;
  return {
    ...filter,
    $or: [{ assignedAgentId: actor.sub }, { assignedAgentId: null }, { assignedAgentId: { $exists: false } }],
  };
}
