/**
 * LID & SenderPn Plotting Utilities untuk Baileys-Joss
 *
 * senderPn = nomor WA yang sedang digunakan (current session)
 * LID = Linked ID yang dipakai WhatsApp untuk identifikasi
 *
 * @module jid-plotting
 */
import type { AuthenticationCreds } from '../Types';
export interface JidInfo {
    /** Full JID string */
    jid: string;
    /** User part (phone number or LID) */
    user: string;
    /** Server/domain part */
    server: string;
    /** Device number (0 = primary) */
    device: number;
    /** Agent (0 = user, 1 = agent) */
    agent: number;
    /** Is this a LID? */
    isLid: boolean;
    /** Is this a phone number (PN)? */
    isPn: boolean;
    /** Is this a hosted account? */
    isHosted: boolean;
    /** Is this a group? */
    isGroup: boolean;
    /** Is this a newsletter? */
    isNewsletter: boolean;
    /** Normalized user (without device) */
    normalizedUser: string;
}
export interface PlottedJid {
    /** Original JID yang diberikan */
    original: string;
    /** Phone number JID */
    pn?: string;
    /** LID */
    lid?: string;
    /** Resolved (primary identifier) */
    primary: string;
    /** Info lengkap */
    info: JidInfo;
}
export interface SenderPnInfo {
    /** Phone number dengan @s.whatsapp.net */
    phoneJid: string;
    /** Phone number tanpa domain */
    phoneNumber: string;
    /** LID jika tersedia */
    lid?: string;
    /** Device ID */
    deviceId: number;
    /** Nama yang tersimpan di account */
    pushName?: string;
    /** Platform (android/ios/web/etc) */
    platform?: string;
}
/**
 * Parse dan extract informasi lengkap dari JID
 */
export declare const parseJid: (jid: string) => JidInfo | null;
/**
 * Get senderPn (current session phone number) dari AuthenticationCreds
 */
export declare const getSenderPn: (creds: AuthenticationCreds) => SenderPnInfo | null;
/**
 * Get current sender info dari authState
 * Ini function yang paling sering dipakai
 */
export declare const getCurrentSenderInfo: (authState: {
    creds: AuthenticationCreds;
}) => SenderPnInfo | null;
/**
 * Check apakah JID adalah diri sendiri (current sender)
 */
export declare const isSelf: (jid: string, senderPn: SenderPnInfo) => boolean;
/**
 * Plot JID - convert antara PN dan LID
 * Ini memerlukan LIDMappingStore untuk full functionality
 */
export declare const plotJid: (jid: string) => PlottedJid | null;
/**
 * Normalize berbagai format nomor ke JID yang valid
 */
export declare const normalizePhoneToJid: (phone: string) => string;
/**
 * Extract phone number dari JID (tanpa domain)
 */
export declare const extractPhoneNumber: (jid: string) => string | null;
/**
 * Buat formatted display untuk JID
 */
export declare const formatJidDisplay: (jid: string, options?: {
    showDevice?: boolean;
    showType?: boolean;
}) => string;
/**
 * Compare dua JID apakah merujuk ke user yang sama
 */
export declare const isSameUser: (jid1: string, jid2: string) => boolean;
/**
 * Get all JID variants dari satu nomor
 * Useful untuk searching across different formats
 */
export declare const getJidVariants: (phone: string) => string[];
/**
 * Construct JID dengan device ID
 */
export declare const constructJidWithDevice: (user: string, device: number, server?: string) => string;
/**
 * Helper untuk mendapatkan remoteJid yang benar dari message
 * Memperhitungkan group dan direct messages
 */
export declare const getRemoteJidFromMessage: (msg: {
    key: {
        remoteJid?: string;
        participant?: string;
    };
}) => {
    chatJid: string;
    senderJid: string;
} | null;
/**
 * Interface untuk plotting dengan external mapping
 */
export interface JidPlotterWithMapping {
    plotToLid: (pn: string) => Promise<string | null>;
    plotToPn: (lid: string) => Promise<string | null>;
    plotBidirectional: (jid: string) => Promise<PlottedJid>;
}
/**
 * Create plotter yang bisa resolve LID <-> PN
 * Membutuhkan getLIDForPN dan getPNForLID dari LIDMappingStore
 */
export declare const createJidPlotter: (getLIDForPN: (pn: string) => Promise<string | null>, getPNForLID: (lid: string) => Promise<string | null>) => JidPlotterWithMapping;
declare const _default: {
    parseJid: (jid: string) => JidInfo | null;
    getSenderPn: (creds: AuthenticationCreds) => SenderPnInfo | null;
    getCurrentSenderInfo: (authState: {
        creds: AuthenticationCreds;
    }) => SenderPnInfo | null;
    isSelf: (jid: string, senderPn: SenderPnInfo) => boolean;
    plotJid: (jid: string) => PlottedJid | null;
    normalizePhoneToJid: (phone: string) => string;
    extractPhoneNumber: (jid: string) => string | null;
    formatJidDisplay: (jid: string, options?: {
        showDevice?: boolean;
        showType?: boolean;
    }) => string;
    isSameUser: (jid1: string, jid2: string) => boolean;
    getJidVariants: (phone: string) => string[];
    constructJidWithDevice: (user: string, device: number, server?: string) => string;
    getRemoteJidFromMessage: (msg: {
        key: {
            remoteJid?: string;
            participant?: string;
        };
    }) => {
        chatJid: string;
        senderJid: string;
    } | null;
    createJidPlotter: (getLIDForPN: (pn: string) => Promise<string | null>, getPNForLID: (lid: string) => Promise<string | null>) => JidPlotterWithMapping;
};
export default _default;
