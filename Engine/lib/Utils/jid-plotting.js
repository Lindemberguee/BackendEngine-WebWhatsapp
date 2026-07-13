"use strict";
/**
 * LID & SenderPn Plotting Utilities untuk Baileys-Joss
 *
 * senderPn = nomor WA yang sedang digunakan (current session)
 * LID = Linked ID yang dipakai WhatsApp untuk identifikasi
 *
 * @module jid-plotting
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createJidPlotter = exports.getRemoteJidFromMessage = exports.constructJidWithDevice = exports.getJidVariants = exports.isSameUser = exports.formatJidDisplay = exports.extractPhoneNumber = exports.normalizePhoneToJid = exports.plotJid = exports.isSelf = exports.getCurrentSenderInfo = exports.getSenderPn = exports.parseJid = void 0;
const WABinary_1 = require("../WABinary");
// Helper functions missing in some Baileys versions
const isPnUser = (jid) => jid?.endsWith('@s.whatsapp.net');
const isHostedPnUser = (jid) => jid?.endsWith('@hosted');
const isHostedLidUser = (jid) => jid?.endsWith('@hosted.lid');
// =====================================================
// CORE FUNCTIONS
// =====================================================
/**
 * Parse dan extract informasi lengkap dari JID
 */
const parseJid = (jid) => {
    if (!jid)
        return null;
    const decoded = (0, WABinary_1.jidDecode)(jid);
    if (!decoded)
        return null;
    const isLidVal = (0, WABinary_1.isLidUser)(jid) || isHostedLidUser(jid);
    const isPnVal = isPnUser(jid) || isHostedPnUser(jid);
    const isGroup = jid.endsWith('@g.us');
    const isNewsletter = jid.endsWith('@newsletter');
    const isHostedVal = jid.includes('@hosted') || isHostedLidUser(jid) || isHostedPnUser(jid);
    return {
        jid,
        user: decoded.user,
        server: decoded.server,
        device: decoded.device || 0,
        agent: 0,
        isLid: !!isLidVal,
        isPn: !!isPnVal,
        isHosted: !!isHostedVal,
        isGroup,
        isNewsletter,
        normalizedUser: (0, WABinary_1.jidNormalizedUser)(jid)
    };
};
exports.parseJid = parseJid;
/**
 * Get senderPn (current session phone number) dari AuthenticationCreds
 */
const getSenderPn = (creds) => {
    if (!creds?.me?.id)
        return null;
    const decoded = (0, WABinary_1.jidDecode)(creds.me.id);
    if (!decoded)
        return null;
    const phoneNumber = decoded.user;
    const phoneJid = `${phoneNumber}@s.whatsapp.net`;
    return {
        phoneJid,
        phoneNumber,
        lid: creds.me.lid || undefined,
        deviceId: decoded.device || 0,
        pushName: creds.me.name,
        platform: creds.platform
    };
};
exports.getSenderPn = getSenderPn;
/**
 * Get current sender info dari authState
 * Ini function yang paling sering dipakai
 */
const getCurrentSenderInfo = (authState) => {
    return (0, exports.getSenderPn)(authState.creds);
};
exports.getCurrentSenderInfo = getCurrentSenderInfo;
/**
 * Check apakah JID adalah diri sendiri (current sender)
 */
const isSelf = (jid, senderPn) => {
    if (!jid || !senderPn)
        return false;
    const normalizedJid = (0, WABinary_1.jidNormalizedUser)(jid);
    const normalizedSelf = (0, WABinary_1.jidNormalizedUser)(senderPn.phoneJid);
    // Check phone number match
    if (normalizedJid === normalizedSelf)
        return true;
    // Check LID match if available
    if (senderPn.lid) {
        const normalizedLid = (0, WABinary_1.jidNormalizedUser)(senderPn.lid);
        if (normalizedJid === normalizedLid)
            return true;
    }
    return false;
};
exports.isSelf = isSelf;
/**
 * Plot JID - convert antara PN dan LID
 * Ini memerlukan LIDMappingStore untuk full functionality
 */
const plotJid = (jid) => {
    const info = (0, exports.parseJid)(jid);
    if (!info)
        return null;
    const result = {
        original: jid,
        primary: jid,
        info
    };
    // Determine what type this is
    if (info.isPn) {
        result.pn = info.normalizedUser;
        result.primary = info.normalizedUser;
    }
    else if (info.isLid) {
        result.lid = info.normalizedUser;
        result.primary = info.normalizedUser;
    }
    return result;
};
exports.plotJid = plotJid;
/**
 * Normalize berbagai format nomor ke JID yang valid
 */
const normalizePhoneToJid = (phone) => {
    // Hapus karakter non-numeric kecuali @
    let cleaned = phone.replace(/[^\d@]/g, '');
    // Jika sudah ada domain, return as-is setelah normalize
    if (phone.includes('@')) {
        return (0, WABinary_1.jidNormalizedUser)(phone);
    }
    // Tambah domain
    return `${cleaned}@s.whatsapp.net`;
};
exports.normalizePhoneToJid = normalizePhoneToJid;
/**
 * Extract phone number dari JID (tanpa domain)
 */
const extractPhoneNumber = (jid) => {
    const info = (0, exports.parseJid)(jid);
    if (!info || !info.isPn)
        return null;
    return info.user;
};
exports.extractPhoneNumber = extractPhoneNumber;
/**
 * Buat formatted display untuk JID
 */
const formatJidDisplay = (jid, options) => {
    const info = (0, exports.parseJid)(jid);
    if (!info)
        return jid;
    let display = info.user;
    if (options?.showDevice && info.device > 0) {
        display += `:${info.device}`;
    }
    if (options?.showType) {
        if (info.isLid)
            display += ' (LID)';
        else if (info.isGroup)
            display += ' (Group)';
        else if (info.isNewsletter)
            display += ' (Newsletter)';
        else if (info.isPn)
            display += ' (PN)';
    }
    return display;
};
exports.formatJidDisplay = formatJidDisplay;
/**
 * Compare dua JID apakah merujuk ke user yang sama
 */
const isSameUser = (jid1, jid2) => {
    const info1 = (0, exports.parseJid)(jid1);
    const info2 = (0, exports.parseJid)(jid2);
    if (!info1 || !info2)
        return false;
    // Normalize dan compare
    return info1.normalizedUser === info2.normalizedUser;
};
exports.isSameUser = isSameUser;
/**
 * Get all JID variants dari satu nomor
 * Useful untuk searching across different formats
 */
const getJidVariants = (phone) => {
    const cleaned = phone.replace(/[^\d]/g, '');
    return [
        `${cleaned}@s.whatsapp.net`,
        `${cleaned}:0@s.whatsapp.net`,
        `${cleaned}@lid`,
        // Dengan device IDs
        `${cleaned}:1@s.whatsapp.net`,
        `${cleaned}:2@s.whatsapp.net`,
    ];
};
exports.getJidVariants = getJidVariants;
/**
 * Construct JID dengan device ID
 */
const constructJidWithDevice = (user, device, server = 's.whatsapp.net') => {
    if (device === 0) {
        return `${user}@${server}`;
    }
    return `${user}:${device}@${server}`;
};
exports.constructJidWithDevice = constructJidWithDevice;
/**
 * Helper untuk mendapatkan remoteJid yang benar dari message
 * Memperhitungkan group dan direct messages
 */
const getRemoteJidFromMessage = (msg) => {
    if (!msg?.key?.remoteJid)
        return null;
    const chatJid = msg.key.remoteJid;
    const isGroupMsg = chatJid.endsWith('@g.us');
    // For group messages, sender is in participant
    // For direct messages, sender is remoteJid
    const senderJid = isGroupMsg
        ? (msg.key.participant || chatJid)
        : chatJid;
    return { chatJid, senderJid };
};
exports.getRemoteJidFromMessage = getRemoteJidFromMessage;
/**
 * Create plotter yang bisa resolve LID <-> PN
 * Membutuhkan getLIDForPN dan getPNForLID dari LIDMappingStore
 */
const createJidPlotter = (getLIDForPN, getPNForLID) => {
    return {
        plotToLid: async (pn) => {
            return await getLIDForPN(pn);
        },
        plotToPn: async (lid) => {
            return await getPNForLID(lid);
        },
        plotBidirectional: async (jid) => {
            const info = (0, exports.parseJid)(jid);
            if (!info) {
                return {
                    original: jid,
                    primary: jid,
                    info: (0, exports.parseJid)(jid)
                };
            }
            const result = {
                original: jid,
                primary: jid,
                info
            };
            if (info.isPn) {
                result.pn = info.normalizedUser;
                const lid = await getLIDForPN(jid);
                if (lid)
                    result.lid = lid;
                result.primary = info.normalizedUser;
            }
            else if (info.isLid) {
                result.lid = info.normalizedUser;
                const pn = await getPNForLID(jid);
                if (pn)
                    result.pn = pn;
                result.primary = result.pn || info.normalizedUser;
            }
            return result;
        }
    };
};
exports.createJidPlotter = createJidPlotter;
exports.default = {
    parseJid: exports.parseJid,
    getSenderPn: exports.getSenderPn,
    getCurrentSenderInfo: exports.getCurrentSenderInfo,
    isSelf: exports.isSelf,
    plotJid: exports.plotJid,
    normalizePhoneToJid: exports.normalizePhoneToJid,
    extractPhoneNumber: exports.extractPhoneNumber,
    formatJidDisplay: exports.formatJidDisplay,
    isSameUser: exports.isSameUser,
    getJidVariants: exports.getJidVariants,
    constructJidWithDevice: exports.constructJidWithDevice,
    getRemoteJidFromMessage: exports.getRemoteJidFromMessage,
    createJidPlotter: exports.createJidPlotter
};
