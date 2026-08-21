import { Conversation, Message } from '../models';

/**
 * Deduplicate conversations with the same phone but different JID formats
 * (e.g., "5511999@s.whatsapp.net" vs "240114458476559@lid").
 *
 * Keeps the conversation with more messages/activity, merges the other into it.
 */
export async function deduplicateConversations(workspaceId: string): Promise<{ merged: number }> {
  const conversations = await Conversation.find({ workspaceId, isGroup: false }).lean();

  // Group by phone number
  const byPhone = new Map<string, typeof conversations>();
  for (const conv of conversations) {
    if (!conv.phone) continue;
    if (!byPhone.has(conv.phone)) byPhone.set(conv.phone, []);
    byPhone.get(conv.phone)!.push(conv);
  }

  let merged = 0;

  // For each phone with multiple JID formats, merge into the one with most messages
  for (const [phone, convs] of byPhone) {
    if (convs.length <= 1) continue;

    // Count messages per conversation
    const withCounts = await Promise.all(
      convs.map(async (c) => ({
        ...c,
        messageCount: await Message.countDocuments({ conversationId: c._id }),
      }))
    );

    // Sort by message count (descending) — keep the one with most activity
    withCounts.sort((a, b) => b.messageCount - a.messageCount);
    const [keeper, ...dupes] = withCounts;

    for (const dupe of dupes) {
      // Move all messages from dupe to keeper
      await Message.updateMany(
        { conversationId: dupe._id },
        { conversationId: keeper._id }
      );

      // Delete the duplicate conversation
      await Conversation.deleteOne({ _id: dupe._id });
      merged++;

      console.log(
        `[Dedup] Merged duplicate conversation ${phone}: ` +
        `kept ${keeper._id} (${keeper.messageCount} msgs), ` +
        `deleted ${dupe._id} (${dupe.messageCount} msgs)`
      );
    }
  }

  return { merged };
}
