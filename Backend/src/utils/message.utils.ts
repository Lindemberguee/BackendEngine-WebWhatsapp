import { normalizeMessageContent } from '@webwhatsapp/engine';
import type { WAMessage } from '@webwhatsapp/engine';
import type { MessageType, IMessage } from '../db/models';

export interface ExtractedContent {
  type: MessageType;
  text: string;
  content: Record<string, unknown>;
}

export function extractMessageContent(msg: WAMessage): ExtractedContent {
  // normalizeMessageContent unwraps ephemeral, viewOnce, viewOnceV2,
  // documentWithCaption, and other container types into their inner message.
  const m = normalizeMessageContent(msg.message);
  if (!m) return { type: 'unknown', text: '', content: {} };

  if (m.conversation || m.extendedTextMessage) {
    const text = m.conversation ?? m.extendedTextMessage?.text ?? '';
    return { type: 'text', text, content: { text } };
  }
  if (m.imageMessage) {
    return { type: 'image', text: m.imageMessage.caption ?? '', content: { caption: m.imageMessage.caption, mimeType: m.imageMessage.mimetype, fileSize: m.imageMessage.fileLength } };
  }
  if (m.videoMessage) {
    return { type: 'video', text: m.videoMessage.caption ?? '', content: { caption: m.videoMessage.caption, mimeType: m.videoMessage.mimetype } };
  }
  if (m.audioMessage) {
    return { type: 'audio', text: '', content: { mimeType: m.audioMessage.mimetype, duration: m.audioMessage.seconds, ptt: m.audioMessage.ptt } };
  }
  if (m.documentMessage) {
    const text = m.documentMessage.fileName ?? m.documentMessage.title ?? '';
    return { type: 'document', text, content: { fileName: m.documentMessage.fileName, mimeType: m.documentMessage.mimetype, fileSize: m.documentMessage.fileLength, title: m.documentMessage.title } };
  }
  if (m.stickerMessage) {
    return { type: 'sticker', text: '', content: { mimeType: m.stickerMessage.mimetype } };
  }
  if (m.locationMessage) {
    const text = m.locationMessage.address ?? `${m.locationMessage.degreesLatitude},${m.locationMessage.degreesLongitude}`;
    return { type: 'location', text, content: { latitude: m.locationMessage.degreesLatitude, longitude: m.locationMessage.degreesLongitude, address: m.locationMessage.address } };
  }
  if (m.contactMessage) {
    return { type: 'contact', text: m.contactMessage.displayName ?? '', content: { name: m.contactMessage.displayName, vcard: m.contactMessage.vcard } };
  }
  // Polls: the engine emits pollCreationMessageV3 (older clients: pollCreationMessage).
  const poll = m.pollCreationMessage ?? (m as Record<string, any>).pollCreationMessageV3;
  if (poll) {
    return { type: 'poll', text: poll.name ?? '', content: { name: poll.name, options: poll.options?.map((o: { optionName?: string }) => o.optionName) } };
  }
  if (m.reactionMessage) {
    return { type: 'reaction', text: m.reactionMessage.text ?? '', content: { emoji: m.reactionMessage.text, targetMessageId: m.reactionMessage.key?.id } };
  }

  // ── Outbound interactive messages WE send from flows (native flow / buttons /
  //    CTA / Pix / carousel / list). Without these they'd store empty and render
  //    as a blank bubble in the conversation. Keep the body text + the buttons so
  //    the chat shows the real content. ──────────────────────────────────────────
  const interactive = (m as Record<string, any>).interactiveMessage;
  if (interactive) {
    const buttons = (interactive.nativeFlowMessage?.buttons ?? []).map((b: { name?: string; buttonParamsJson?: string }) => {
      try { const p = JSON.parse(b.buttonParamsJson ?? '{}'); return { name: b.name, label: p.display_text ?? p.title }; }
      catch { return { name: b.name }; }
    });
    const isCarousel = !!interactive.carouselMessage;
    const text = interactive.body?.text?.trim() || interactive.header?.title || (isCarousel ? '🖼️ Carrossel' : '');
    return { type: 'interactive', text, content: { text: interactive.body?.text, title: interactive.header?.title, footer: interactive.footer?.text, buttons, carousel: isCarousel } };
  }
  const buttonsMsg = (m as Record<string, any>).buttonsMessage;
  if (buttonsMsg) {
    const buttons = (buttonsMsg.buttons ?? []).map((b: { buttonText?: { displayText?: string } }) => ({ label: b.buttonText?.displayText }));
    const text = buttonsMsg.contentText ?? buttonsMsg.text ?? '';
    return { type: 'interactive', text, content: { text, footer: buttonsMsg.footerText, buttons } };
  }
  const listMsg = (m as Record<string, any>).listMessage;
  if (listMsg) {
    const text = listMsg.description ?? listMsg.title ?? '';
    return { type: 'interactive', text, content: { text, title: listMsg.title, buttonText: listMsg.buttonText, footer: listMsg.footerText } };
  }

  // Button / interactive responses — treat as text with the selected label
  const buttonReply = (m as Record<string, unknown>).buttonsResponseMessage as { selectedDisplayText?: string } | undefined;
  if (buttonReply?.selectedDisplayText) {
    return { type: 'text', text: buttonReply.selectedDisplayText, content: { text: buttonReply.selectedDisplayText } };
  }
  const listReply = (m as Record<string, unknown>).listResponseMessage as { title?: string; singleSelectReply?: { selectedRowId?: string } } | undefined;
  if (listReply) {
    const text = listReply.title ?? listReply.singleSelectReply?.selectedRowId ?? '';
    return { type: 'text', text, content: { text } };
  }
  const interactiveReply = (m as Record<string, unknown>).interactiveResponseMessage as { nativeFlowResponseMessage?: { paramsJson?: string }; body?: { text?: string } } | undefined;
  if (interactiveReply) {
    const text = interactiveReply.body?.text ?? '';
    return { type: 'text', text, content: { text } };
  }
  const templateReply = (m as Record<string, unknown>).templateButtonReplyMessage as { selectedDisplayText?: string } | undefined;
  if (templateReply?.selectedDisplayText) {
    return { type: 'text', text: templateReply.selectedDisplayText, content: { text: templateReply.selectedDisplayText } };
  }

  return { type: 'unknown', text: '', content: m as Record<string, unknown> };
}

/**
 * Build a human-readable preview for Conversation.lastMessage.
 * Text messages show their text; media shows a labelled emoji (with caption if present)
 * so the conversation list never renders a blank "Sem mensagens" for real content.
 */
export function lastMessagePreview(type: MessageType, text: string): string {
  if (text && text.trim()) {
    // For media with a caption, prefix the emoji so it's clear it's an attachment.
    switch (type) {
      case 'image': return `📷 ${text}`;
      case 'video': return `🎥 ${text}`;
      case 'document': return `📄 ${text}`;
      default: return text;
    }
  }
  switch (type) {
    case 'image': return '📷 Imagem';
    case 'video': return '🎥 Vídeo';
    case 'audio': return '🎤 Áudio';
    case 'document': return '📄 Documento';
    case 'sticker': return '🏷️ Figurinha';
    case 'location': return '📍 Localização';
    case 'contact': return '👤 Contato';
    case 'poll': return '📊 Enquete';
    case 'reaction': return text || '👍';
    case 'system': return text || 'Evento do sistema';
    default: return text || 'Mensagem';
  }
}

export function parseJid(jid: string): string {
  return jid.replace(/@.*$/, '').replace(/:\d+$/, '');
}

export function buildJid(phone: string): string {
  const clean = phone.replace(/\D/g, '');
  return `${clean}@s.whatsapp.net`;
}

/**
 * Extract standardized media metadata from WAMessage.
 * Returns type-specific metadata that should be stored in Message.media + Message.content.
 */
export function extractMediaMetadata(msg: WAMessage): Record<string, Record<string, unknown>> {
  const m = msg.message;
  if (!m) return {};

  const metadata: Record<string, Record<string, unknown>> = {};

  // Image
  if (m.imageMessage) {
    const img = m.imageMessage;
    metadata.image = {
      width: img.width,
      height: img.height,
      fileSize: img.fileLength,
      ...(img.jpegThumbnail ? { thumbnail: Buffer.from(img.jpegThumbnail).toString('base64') } : {}),
      ...(img.mediaKey ? { mediaKey: Buffer.from(img.mediaKey).toString('base64') } : {}),
      ...(img.directPath ? { directPath: img.directPath } : {}),
    };
  }

  // Video
  if (m.videoMessage) {
    const vid = m.videoMessage;
    metadata.video = {
      width: vid.width,
      height: vid.height,
      duration: (vid.seconds ?? 0) * 1000, // Convert seconds to milliseconds
      fileSize: vid.fileLength,
      isGif: vid.gifPlayback ?? false,
      ...(vid.jpegThumbnail ? { thumbnail: Buffer.from(vid.jpegThumbnail).toString('base64') } : {}),
      ...(vid.mediaKey ? { mediaKey: Buffer.from(vid.mediaKey).toString('base64') } : {}),
      ...(vid.directPath ? { directPath: vid.directPath } : {}),
      ...(vid.gifAttribution ? { gifAttribution: vid.gifAttribution } : {}),
    };
  }

  // Audio
  if (m.audioMessage) {
    const aud = m.audioMessage;
    metadata.audio = {
      duration: (aud.seconds ?? 0) * 1000, // Convert seconds to milliseconds
      isVoiceMessage: aud.ptt ?? false,
      fileSize: aud.fileLength,
      ...(aud.waveform ? { waveform: Buffer.from(aud.waveform).toString('base64') } : {}),
      ...(aud.mediaKey ? { mediaKey: Buffer.from(aud.mediaKey).toString('base64') } : {}),
      ...(aud.directPath ? { directPath: aud.directPath } : {}),
    };
  }

  // Document
  if (m.documentMessage) {
    const doc = m.documentMessage;
    metadata.document = {
      fileName: doc.fileName,
      fileSize: doc.fileLength,
      ...(doc.jpegThumbnail ? { thumbnail: Buffer.from(doc.jpegThumbnail).toString('base64') } : {}),
      ...(doc.mediaKey ? { mediaKey: Buffer.from(doc.mediaKey).toString('base64') } : {}),
      ...(doc.directPath ? { directPath: doc.directPath } : {}),
    };
  }

  // Sticker
  if (m.stickerMessage) {
    const stick = m.stickerMessage;
    metadata.sticker = {
      isAnimated: stick.isAnimated ?? false,
      width: stick.width,
      height: stick.height,
      ...(stick.mediaKey ? { mediaKey: Buffer.from(stick.mediaKey).toString('base64') } : {}),
      ...(stick.directPath ? { directPath: stick.directPath } : {}),
    };
  }

  return metadata;
}

/**
 * Extract a text preview from a message for display when it's quoted.
 * Returns first 100 chars of text or a type emoji for media.
 */
export function extractPreview(msg: IMessage, maxLen = 100): string {
  if (msg.type === 'text') {
    const text = (msg.content as any)?.text || '';
    return text.slice(0, maxLen);
  }
  if (msg.type === 'image') return '🖼️ Photo';
  if (msg.type === 'video') return '🎥 Video';
  if (msg.type === 'audio') return '🎵 Audio';
  if (msg.type === 'document') {
    const fileName = (msg.content as any)?.fileName || 'Document';
    return `📄 ${fileName}`;
  }
  if (msg.type === 'sticker') return '🎨 Sticker';
  if (msg.type === 'location') return '📍 Location';
  if (msg.type === 'contact') {
    const name = (msg.content as any)?.name || 'Contact';
    return `👤 ${name}`;
  }
  if (msg.type === 'poll') {
    const name = (msg.content as any)?.name || 'Poll';
    return `🗳️ ${name}`;
  }
  return msg.type.toUpperCase();
}
