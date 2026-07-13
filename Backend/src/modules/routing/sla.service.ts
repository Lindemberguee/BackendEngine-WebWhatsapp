import { Types } from 'mongoose';
import pino from 'pino';
import { Conversation, TeamGroup, Workspace } from '../../db/models';
import type { IBusinessHours, ITeamGroupSla } from '../../db/models';
import { resolveBusinessHours, isWithinBusinessHours } from './routing.service';

const logger = pino({ level: process.env.LOG_LEVEL ?? 'info' });

const SEARCH_STEP_MS = 15 * 60_000; // 15 minutes
const SEARCH_CAP_MS = 14 * 24 * 60 * 60_000; // give up after 14 days of searching (misconfigured hours)

/** Queue-level SLA policy wins; falls back to the workspace default; absent/disabled means no SLA tracked. */
function resolveSla(
  team: { sla?: ITeamGroupSla } | null | undefined,
  workspace: { settings?: Record<string, unknown> } | null | undefined
): ITeamGroupSla | null {
  if (team?.sla?.enabled) return team.sla;
  const fallback = workspace?.settings?.defaultSla as ITeamGroupSla | undefined;
  return fallback?.enabled ? fallback : null;
}

/** Walk forward in 15-minute steps to the next instant business hours are open. No-op (returns `from`) when there's no config — the caller only invokes this when already outside hours. */
function nextOpeningTime(config: IBusinessHours | null | undefined, from: Date): Date {
  if (!config?.schedule?.length) return from;
  let candidate = new Date(from.getTime());
  const deadline = from.getTime() + SEARCH_CAP_MS;
  while (candidate.getTime() < deadline) {
    if (isWithinBusinessHours(config, candidate)) return candidate;
    candidate = new Date(candidate.getTime() + SEARCH_STEP_MS);
  }
  logger.warn({ config }, '[sla] could not find an opening within business hours search window — falling back to now');
  return from;
}

/**
 * Starts the SLA clock for a ticket the moment a customer message opens/reopens
 * it — but only if no clock is already running (so replies within an already-open
 * ticket don't reset the deadline). No-ops when the queue/workspace has no SLA
 * policy enabled. Never throws.
 */
export async function applySlaTimers(conversationId: string, workspaceId: string, teamGroupId?: string | null): Promise<void> {
  try {
    const conv = await Conversation.findById(conversationId).select('firstResponseDueAt resolutionDueAt');
    if (!conv || conv.firstResponseDueAt || conv.resolutionDueAt) return; // clock already running

    const team = teamGroupId && Types.ObjectId.isValid(teamGroupId)
      ? await TeamGroup.findById(teamGroupId).select('sla businessHours').lean()
      : null;
    const workspace = await Workspace.findById(workspaceId).select('settings').lean();

    const sla = resolveSla(team, workspace);
    if (!sla) return;

    const hours = resolveBusinessHours(team, workspace);
    const now = new Date();
    const clockStart = isWithinBusinessHours(hours, now) ? now : nextOpeningTime(hours, now);

    const update: Record<string, unknown> = { slaFirstResponseBreached: false, slaResolutionBreached: false };
    if (sla.firstResponseMinutes) update.firstResponseDueAt = new Date(clockStart.getTime() + sla.firstResponseMinutes * 60_000);
    if (sla.resolutionMinutes) update.resolutionDueAt = new Date(clockStart.getTime() + sla.resolutionMinutes * 60_000);
    if (update.firstResponseDueAt || update.resolutionDueAt) {
      await Conversation.updateOne({ _id: conversationId }, { $set: update });
    }
  } catch (err) {
    logger.warn({ err, conversationId }, '[sla] applySlaTimers failed');
  }
}

/** Marks the first-response clock stopped — called when a human agent (not a flow/bot) sends the ticket's first reply. */
export async function markFirstResponse(conversationId: string): Promise<void> {
  try {
    await Conversation.updateOne(
      { _id: conversationId, firstRespondedAt: { $exists: false } },
      { $set: { firstRespondedAt: new Date() } }
    );
  } catch (err) {
    logger.warn({ err, conversationId }, '[sla] markFirstResponse failed');
  }
}

/** Clears all SLA state — called whenever a ticket resolves/closes so a future reopen starts a fresh clock. */
export async function clearSlaTimers(conversationId: string): Promise<void> {
  try {
    await Conversation.updateOne(
      { _id: conversationId },
      {
        $unset: { firstResponseDueAt: 1, firstRespondedAt: 1, resolutionDueAt: 1 },
        $set: { slaFirstResponseBreached: false, slaResolutionBreached: false },
      }
    );
  } catch (err) {
    logger.warn({ err, conversationId }, '[sla] clearSlaTimers failed');
  }
}
