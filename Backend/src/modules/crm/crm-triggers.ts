import { Flow, FlowRun, Conversation, Contact, type ILead } from '../../db/models';
import type { SessionManager } from '../../session-manager/SessionManager';
import pino from 'pino';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

export type CrmTriggerEvent = 'stage_changed' | 'won' | 'lost';

/**
 * Reverse automation: a lead's stage/status change can start a flow, mirroring
 * how flows can already push into the CRM (crm.create_lead / crm.move_stage).
 * Requires the lead to be linked to a conversation — a flow can only run
 * against a live WhatsApp conversation, so leads created purely manually with
 * no conversationId never trigger anything here.
 *
 * Never throws into the caller — a misconfigured/missing flow must not break
 * the CRM action that triggered it.
 */
export async function triggerCrmFlow(
  sessionManager: SessionManager,
  workspaceId: string,
  lead: Pick<ILead, 'conversationId' | 'pipelineId' | 'stageId'>,
  event: CrmTriggerEvent
): Promise<void> {
  try {
    if (!lead.conversationId) return;
    const conversation = await Conversation.findById(lead.conversationId).lean();
    if (!conversation?.instanceId) return;

    // Don't step on an already-active flow for this conversation.
    const activeRun = await FlowRun.exists({
      conversationId: String(conversation._id),
      status: { $in: ['running', 'waiting'] },
    });
    if (activeRun) return;

    const flows = await Flow.find({
      workspaceId, enabled: true, 'trigger.type': 'crm_event', 'trigger.crmEvent': event,
    }).lean();
    const match = flows.find((f) => {
      const t = f.trigger as unknown as { crmPipelineId?: string; crmStageId?: string };
      if (t.crmPipelineId && String(t.crmPipelineId) !== String(lead.pipelineId)) return false;
      if (t.crmStageId && t.crmStageId !== lead.stageId) return false;
      return true;
    });
    if (!match) return;

    const flowDoc = await Flow.findById(match._id);
    if (!flowDoc) return;

    const session = sessionManager.getSession(String(conversation.instanceId));
    if (!session) return;

    const contact = conversation.contactId ? await Contact.findById(conversation.contactId).lean() : null;
    await session.triggerFlow(flowDoc, {
      conversationId: String(conversation._id),
      jid: conversation.jid,
      contact: { name: contact?.name ?? conversation.name, phone: contact?.phone ?? conversation.phone },
    });
  } catch (err) {
    logger.warn({ err, event }, '[crm] flow trigger failed');
  }
}
