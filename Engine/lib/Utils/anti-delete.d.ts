/**
 * Anti-Delete / Message Store untuk Baileys-Joss
 *
 * Fitur untuk menyimpan dan recover deleted messages
 *
 * @module anti-delete
 */
import type { WAMessage, WAMessageKey } from '../Types';
export interface StoredMessage {
    /** Original message */
    message: WAMessage;
    /** Timestamp disimpan */
    storedAt: number;
    /** Sudah dihapus */
    isDeleted: boolean;
    /** Timestamp dihapus */
    deletedAt?: number;
    /** Siapa yang menghapus */
    deletedBy?: string;
}
export interface DeletedMessageInfo {
    /** Original message sebelum dihapus */
    originalMessage: WAMessage;
    /** Key dari message yang dihapus */
    key: WAMessageKey;
    /** Timestamp dihapus */
    deletedAt: number;
    /** Siapa yang menghapus (participant untuk group) */
    deletedBy?: string;
    /** Apakah dihapus oleh pengirim (delete for everyone) */
    isRevokedBySender: boolean;
}
export interface MessageStoreOptions {
    /** Max messages per chat */
    maxMessagesPerChat?: number;
    /** TTL dalam ms (default 24 jam) */
    ttl?: number;
    /** Auto cleanup interval dalam ms */
    cleanupInterval?: number;
}
export declare class MessageStore {
    private store;
    private deletedMessages;
    private options;
    private cleanupTimer?;
    constructor(options?: MessageStoreOptions);
    private startCleanup;
    /**
     * Stop cleanup timer
     */
    stopCleanup(): void;
    /**
     * Cleanup old messages
     */
    cleanup(): void;
    /**
     * Get store key dari message key
     */
    private getKey;
    /**
     * Store message
     */
    storeMessage(message: WAMessage): void;
    /**
     * Store multiple messages
     */
    storeMessages(messages: WAMessage[]): void;
    /**
     * Get stored message
     */
    getMessage(key: WAMessageKey): StoredMessage | undefined;
    /**
     * Get original message (untuk anti-delete)
     */
    getOriginalMessage(key: WAMessageKey): WAMessage | undefined;
    /**
     * Mark message as deleted dan store info
     */
    markAsDeleted(key: WAMessageKey, deletedBy?: string): DeletedMessageInfo | null;
    /**
     * Get deleted message info
     */
    getDeletedMessage(key: WAMessageKey): DeletedMessageInfo | undefined;
    /**
     * Get all deleted messages
     */
    getAllDeletedMessages(): DeletedMessageInfo[];
    /**
     * Get deleted messages by chat
     */
    getDeletedMessagesByChat(chatId: string): DeletedMessageInfo[];
    /**
     * Get all messages in chat
     */
    getChatMessages(chatId: string): WAMessage[];
    /**
     * Get chat IDs
     */
    getChatIds(): string[];
    /**
     * Get stats
     */
    getStats(): {
        totalChats: number;
        totalMessages: number;
        totalDeleted: number;
    };
    /**
     * Clear all
     */
    clear(): void;
    /**
     * Clear chat
     */
    clearChat(chatId: string): void;
    /**
     * Get all messages in all chats (compatibility for bot saving)
     */
    getAllMessages(): {
        [jid: string]: WAMessage[];
    };
}
/**
 * Check apakah message adalah delete/revoke message
 */
export declare const isDeleteMessage: (message: WAMessage) => boolean;
/**
 * Get deleted message key dari revoke message
 */
export declare const getDeletedMessageKey: (message: WAMessage) => WAMessageKey | null;
/**
 * Create anti-delete handler
 * Bisa dipasang ke sock.ev.on('messages.update')
 */
export declare const createAntiDeleteHandler: (store: MessageStore) => (updates: {
    key: WAMessageKey;
    update: Partial<WAMessage>;
}[]) => DeletedMessageInfo[];
/**
 * Create message store handler
 * Bisa dipasang ke sock.ev.on('messages.upsert')
 */
export declare const createMessageStoreHandler: (store: MessageStore) => ({ messages }: {
    messages: WAMessage[];
}) => void;
declare const _default: {
    MessageStore: typeof MessageStore;
    isDeleteMessage: (message: WAMessage) => boolean;
    getDeletedMessageKey: (message: WAMessage) => WAMessageKey | null;
    createAntiDeleteHandler: (store: MessageStore) => (updates: {
        key: WAMessageKey;
        update: Partial<WAMessage>;
    }[]) => DeletedMessageInfo[];
    createMessageStoreHandler: (store: MessageStore) => ({ messages }: {
        messages: WAMessage[];
    }) => void;
};
export default _default;
