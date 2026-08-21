/**
 * Channel-neutral outbound message representation (IR). `buildOutboundMessage()`
 * (flow-executor/senders.ts) turns a flow block into one of these; a per-channel
 * translator (channels/baileys/to-baileys.ts, channels/cloud-api/to-cloud-api.ts)
 * turns it into the wire format that channel actually accepts. Nothing upstream
 * of `buildOutboundMessage` (the flow runner, campaigns) needs to know which
 * channel it's ultimately headed to.
 */

export interface OutboundButton {
  /** 'reply' = quick-reply (id echoed back on tap); the rest open something. */
  type: 'reply' | 'url' | 'call' | 'copy';
  label: string;
  /** reply: the id resumed via the flow's waiting port. url/call/copy: the target value. */
  value: string;
}

export type OutboundMessage =
  | { kind: 'text'; text: string }
  | { kind: 'image'; url: string; caption?: string; viewOnce?: boolean }
  | { kind: 'video'; url: string; caption?: string; gifPlayback?: boolean; viewOnce?: boolean }
  | { kind: 'audio'; url: string; ptt?: boolean }
  | { kind: 'document'; url: string; fileName: string; mimetype: string; caption?: string }
  | { kind: 'buttons'; body: string; buttons: OutboundButton[] }
  | { kind: 'cta'; body: string; footer?: string; headerImageUrl?: string; buttons: OutboundButton[] }
  | { kind: 'list'; body: string; title?: string; buttonText: string; sections: { title: string; rows: { id: string; title: string; description?: string }[] }[] }
  | { kind: 'carousel'; cards: { id: string; title: string; imageUrl?: string; buttonLabel: string }[] }
  | { kind: 'pix'; body: string; footer?: string; qrCodeUrl?: string; buttonLabel: string; pixKey: string }
  | { kind: 'poll'; question: string; options: string[]; multiSelect: boolean }
  | { kind: 'location'; latitude: number; longitude: number; name?: string; address?: string }
  | { kind: 'contact'; name: string; phone: string; organization?: string }
  | { kind: 'reaction'; emoji: string; key: { id: string; remoteJid: string; fromMe: boolean } }
  /** Cloud API only — an approved HSM template. Baileys has no equivalent; a
   *  Baileys-targeted flow can never produce this (see buildOutboundMessage). */
  | { kind: 'template'; templateName: string; language: string; components?: unknown };
