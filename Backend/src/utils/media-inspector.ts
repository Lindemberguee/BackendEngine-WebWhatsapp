import type { WAMessage } from '@webwhatsapp/engine';
import pino from 'pino';

const logger = pino({ level: 'debug' });

/**
 * Inspect media messages and log all available metadata.
 * Use this to understand what the WhatsApp Engine provides for different media types.
 */
export function inspectMediaMessage(msg: WAMessage): void {
  if (!msg.message) return;

  const msgBody = msg.message;
  const extractMetadata = (mediaMsg: Record<string, unknown>) => {
    const metadata: Record<string, unknown> = {};

    // Standard media fields
    if ('mediaKey' in mediaMsg && mediaMsg.mediaKey) metadata.mediaKey = '✓ present';
    if ('url' in mediaMsg && mediaMsg.url) metadata.url = '✓ present';
    if ('directPath' in mediaMsg && mediaMsg.directPath) metadata.directPath = '✓ present';
    if ('fileSize' in mediaMsg && mediaMsg.fileSize) metadata.fileSize = mediaMsg.fileSize;
    if ('mimeType' in mediaMsg && mediaMsg.mimeType) metadata.mimeType = mediaMsg.mimeType;

    // Image/Video
    if ('width' in mediaMsg && mediaMsg.width) metadata.width = mediaMsg.width;
    if ('height' in mediaMsg && mediaMsg.height) metadata.height = mediaMsg.height;
    if ('jpegThumbnail' in mediaMsg && mediaMsg.jpegThumbnail) metadata.jpegThumbnail = '✓ present (buffer)';

    // Audio/Video
    if ('seconds' in mediaMsg && mediaMsg.seconds) metadata.duration_seconds = mediaMsg.seconds;

    // Video specific
    if ('gifPlayback' in mediaMsg && mediaMsg.gifPlayback) metadata.gifPlayback = mediaMsg.gifPlayback;
    if ('gifAttribution' in mediaMsg && mediaMsg.gifAttribution) metadata.gifAttribution = mediaMsg.gifAttribution;

    // Document
    if ('fileName' in mediaMsg && mediaMsg.fileName) metadata.fileName = mediaMsg.fileName;
    if ('title' in mediaMsg && mediaMsg.title) metadata.title = mediaMsg.title;

    // Sticker
    if ('isAnimated' in mediaMsg && mediaMsg.isAnimated) metadata.isAnimated = mediaMsg.isAnimated;
    if ('pngData' in mediaMsg && mediaMsg.pngData) metadata.pngData = '✓ present (buffer)';

    // Audio specific
    if ('ptt' in mediaMsg && mediaMsg.ptt) metadata.ptt = '✓ voice message';
    if ('waveform' in mediaMsg && mediaMsg.waveform) metadata.waveform = '✓ present (buffer)';

    return metadata;
  };

  // Image
  if (msgBody.imageMessage) {
    logger.info({ type: 'IMAGE', metadata: extractMetadata(msgBody.imageMessage) }, '📷 Image Message');
  }

  // Video
  if (msgBody.videoMessage) {
    logger.info({ type: 'VIDEO', metadata: extractMetadata(msgBody.videoMessage) }, '🎥 Video Message');
  }

  // Audio
  if (msgBody.audioMessage) {
    logger.info({ type: 'AUDIO', metadata: extractMetadata(msgBody.audioMessage) }, '🎵 Audio Message');
  }

  // Document
  if (msgBody.documentMessage) {
    logger.info({ type: 'DOCUMENT', metadata: extractMetadata(msgBody.documentMessage) }, '📄 Document Message');
  }

  // Sticker
  if (msgBody.stickerMessage) {
    logger.info({ type: 'STICKER', metadata: extractMetadata(msgBody.stickerMessage) }, '🏷️ Sticker Message');
  }
}
