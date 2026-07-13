import type { IFlow, IFlowNode, IFlowEdge } from '../db/models';

/** Normalize persisted nodes (frontend xyflow shape → { id, blockType, config }). */
export function normalizeNodes(flow: IFlow): IFlowNode[] {
  const raw = (flow.nodes ?? []) as unknown as Array<Record<string, unknown>>;
  return raw.map((n) => {
    const data = (n.data ?? {}) as Record<string, unknown>;
    return {
      id: String(n.id),
      blockType: String(n.blockType ?? data.blockType ?? ''),
      config: (n.config ?? data.config ?? {}) as Record<string, unknown>,
      position: n.position as { x: number; y: number } | undefined,
    };
  });
}

export function normalizeEdges(flow: IFlow): IFlowEdge[] {
  const raw = (flow.edges ?? []) as unknown as Array<Record<string, unknown>>;
  return raw.map((e) => ({
    id: String(e.id ?? ''),
    source: String(e.source),
    sourceHandle: (e.sourceHandle as string | null) ?? null,
    target: String(e.target),
    targetHandle: (e.targetHandle as string | null) ?? null,
  }));
}

export function nodeById(nodes: IFlowNode[], id: string | undefined): IFlowNode | undefined {
  return id ? nodes.find((n) => n.id === id) : undefined;
}

/** The target node reached by leaving `nodeId` through `portId` (defaults to 'out'). */
export function nextNodeId(edges: IFlowEdge[], nodeId: string, portId = 'out'): string | undefined {
  // Prefer an edge with the exact sourceHandle; fall back to a handle-less edge.
  const exact = edges.find((e) => e.source === nodeId && (e.sourceHandle ?? 'out') === portId);
  if (exact) return exact.target;
  const loose = edges.find((e) => e.source === nodeId && !e.sourceHandle);
  return loose?.target;
}

/** The entry node: the trigger block, else the node with no incoming edge. */
export function entryNode(nodes: IFlowNode[], edges: IFlowEdge[]): IFlowNode | undefined {
  const trigger = nodes.find((n) => n.blockType === 'automation.trigger');
  if (trigger) return trigger;
  const hasIncoming = new Set(edges.map((e) => e.target));
  return nodes.find((n) => !hasIncoming.has(n.id));
}
