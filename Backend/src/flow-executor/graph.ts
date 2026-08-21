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

// Block types that pause the run for a reply/selection instead of continuing on
// their own — a cycle that passes through one of these is not a runaway-message
// risk, since it only advances again when a *new* inbound event resumes it (see
// runner.ts's waitingPorts()/action.wait_response/action.save_response). A cycle
// made up purely of auto-advancing nodes (messages, conditions, actions, delay,
// typing…) is the actual flood risk this check exists to catch before publish.
const PAUSING_BLOCK_TYPES = new Set([
  'message.buttons', 'message.cta', 'message.list', 'message.carousel',
  'action.wait_response', 'action.save_response',
]);

export interface GraphValidationError {
  code: 'no_entry' | 'dangling_edge' | 'cycle';
  message: string;
  nodeIds?: string[];
}

/**
 * Validates a flow's graph shape before it's allowed to go live (POST /:id/publish
 * and PATCH .../:id with enabled:true) — previously nothing checked this, so a
 * flow with no entry point ran nothing (silently, forever) and a flow with an
 * auto-advancing cycle (e.g. message → delay → back to itself) could be published
 * and flood the customer with messages until the run's step budget kicked in.
 */
export function validateFlowGraph(nodes: IFlowNode[], edges: IFlowEdge[]): GraphValidationError[] {
  const errors: GraphValidationError[] = [];
  if (nodes.length === 0) {
    errors.push({ code: 'no_entry', message: 'O fluxo está vazio' });
    return errors;
  }

  const entry = entryNode(nodes, edges);
  if (!entry) {
    errors.push({ code: 'no_entry', message: 'Nenhum bloco de entrada encontrado — adicione um gatilho ou um bloco sem conexão de entrada' });
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const danglingEdges = edges.filter((e) => !nodeIds.has(e.source) || !nodeIds.has(e.target));
  if (danglingEdges.length) {
    errors.push({
      code: 'dangling_edge',
      message: 'Existem conexões apontando para blocos que não existem mais',
      nodeIds: danglingEdges.map((e) => e.source),
    });
  }

  // DFS cycle detection restricted to auto-advancing nodes only (see
  // PAUSING_BLOCK_TYPES above) — edges leaving a pausing node don't count as part
  // of the "runs on its own" subgraph, since they only fire on a fresh inbound event.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, string[]>();
  for (const e of edges) {
    const source = byId.get(e.source);
    if (!source || PAUSING_BLOCK_TYPES.has(source.blockType)) continue;
    if (!nodeIds.has(e.target)) continue;
    const list = adjacency.get(e.source) ?? [];
    list.push(e.target);
    adjacency.set(e.source, list);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const cycleNodes: string[] = [];
  let foundCycle = false;

  function visit(id: string): void {
    if (foundCycle) return;
    color.set(id, GRAY);
    for (const next of adjacency.get(id) ?? []) {
      const c = color.get(next) ?? WHITE;
      if (c === GRAY) { foundCycle = true; cycleNodes.push(id, next); return; }
      if (c === WHITE) { visit(next); if (foundCycle) return; }
    }
    color.set(id, BLACK);
  }

  for (const node of nodes) {
    if (foundCycle) break;
    if ((color.get(node.id) ?? WHITE) === WHITE) visit(node.id);
  }

  if (foundCycle) {
    errors.push({
      code: 'cycle',
      message: 'Existe um loop entre blocos que se repetem automaticamente (sem esperar resposta) — isso enviaria mensagens sem parar',
      nodeIds: cycleNodes,
    });
  }

  return errors;
}
