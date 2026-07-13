"use strict";
/**
 * Anti-Delete / Message Store untuk Baileys-Joss
 *
 * Fitur untuk menyimpan dan recover deleted messages
 *
 * @module anti-delete
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createMessageStoreHandler = exports.createAntiDeleteHandler = exports.getDeletedMessageKey = exports.isDeleteMessage = exports.MessageStore = void 0;
const index_js_1 = require("../../WAProto/index.js");
// =====================================================
// MESSAGE STORE CLASS
// =====================================================
class MessageStore {
    constructor(options = {}) {
        this.store = new Map();
        this.deletedMessages = new Map();
        this.options = {
            maxMessagesPerChat: options.maxMessagesPerChat || 1000,
            ttl: options.ttl || 24 * 60 * 60 * 1000, // 24 hours
            cleanupInterval: options.cleanupInterval || 60 * 60 * 1000 // 1 hour
        };
        // Start cleanup timer
        this.startCleanup();
    }
    startCleanup() {
        this.cleanupTimer = setInterval(() => {
            this.cleanup();
        }, this.options.cleanupInterval);
    }
    /**
     * Stop cleanup timer
     */
    stopCleanup() {
        if (this.cleanupTimer) {
            clearInterval(this.cleanupTimer);
        }
    }
    /**
     * Cleanup old messages
     */
    cleanup() {
        const now = Date.now();
        const cutoff = now - this.options.ttl;
        for (const [chatId, messages] of this.store) {
            for (const [msgId, stored] of messages) {
                if (stored.storedAt < cutoff) {
                    messages.delete(msgId);
                }
            }
            if (messages.size === 0) {
                this.store.delete(chatId);
            }
        }
        // Cleanup deleted messages
        for (const [key, info] of this.deletedMessages) {
            if (info.deletedAt < cutoff) {
                this.deletedMessages.delete(key);
            }
        }
    }
    /**
     * Get store key dari message key
     */
    getKey(key) {
        return `${key.remoteJid}:${key.id}`;
    }
    /**
     * Store message
     */
    storeMessage(message) {
        const chatId = message.key.remoteJid;
        if (!chatId || !message.key.id)
            return;
        let chatMessages = this.store.get(chatId);
        if (!chatMessages) {
            chatMessages = new Map();
            this.store.set(chatId, chatMessages);
        }
        // Enforce max messages per chat
        if (chatMessages.size >= this.options.maxMessagesPerChat) {
            // Remove oldest message
            const oldestKey = chatMessages.keys().next().value;
            if (oldestKey) {
                chatMessages.delete(oldestKey);
            }
        }
        chatMessages.set(message.key.id, {
            message,
            storedAt: Date.now(),
            isDeleted: false
        });
    }
    /**
     * Store multiple messages
     */
    storeMessages(messages) {
        for (const msg of messages) {
            this.storeMessage(msg);
        }
    }
    /**
     * Get stored message
     */
    getMessage(key) {
        const chatMessages = this.store.get(key.remoteJid);
        if (!chatMessages)
            return undefined;
        return chatMessages.get(key.id);
    }
    /**
     * Get original message (untuk anti-delete)
     */
    getOriginalMessage(key) {
        return this.getMessage(key)?.message;
    }
    /**
     * Mark message as deleted dan store info
     */
    markAsDeleted(key, deletedBy) {
        const stored = this.getMessage(key);
        if (!stored)
            return null;
        const now = Date.now();
        stored.isDeleted = true;
        stored.deletedAt = now;
        stored.deletedBy = deletedBy;
        const info = {
            originalMessage: stored.message,
            key,
            deletedAt: now,
            deletedBy,
            isRevokedBySender: !deletedBy || deletedBy === stored.message.key.participant
        };
        this.deletedMessages.set(this.getKey(key), info);
        return info;
    }
    /**
     * Get deleted message info
     */
    getDeletedMessage(key) {
        return this.deletedMessages.get(this.getKey(key));
    }
    /**
     * Get all deleted messages
     */
    getAllDeletedMessages() {
        return Array.from(this.deletedMessages.values());
    }
    /**
     * Get deleted messages by chat
     */
    getDeletedMessagesByChat(chatId) {
        return Array.from(this.deletedMessages.values())
            .filter(info => info.key.remoteJid === chatId);
    }
    /**
     * Get all messages in chat
     */
    getChatMessages(chatId) {
        const chatMessages = this.store.get(chatId);
        if (!chatMessages)
            return [];
        return Array.from(chatMessages.values()).map(s => s.message);
    }
    /**
     * Get chat IDs
     */
    getChatIds() {
        return Array.from(this.store.keys());
    }
    /**
     * Get stats
     */
    getStats() {
        let totalMessages = 0;
        for (const messages of this.store.values()) {
            totalMessages += messages.size;
        }
        return {
            totalChats: this.store.size,
            totalMessages,
            totalDeleted: this.deletedMessages.size
        };
    }
    /**
     * Clear all
     */
    clear() {
        this.store.clear();
        this.deletedMessages.clear();
    }
    /**
     * Clear chat
     */
    clearChat(chatId) {
        this.store.delete(chatId);
    }
    /**
     * Get all messages in all chats (compatibility for bot saving)
     */
    getAllMessages() {
        const all = {};
        for (const [chatId, messages] of this.store) {
            all[chatId] = Array.from(messages.values()).map(s => s.message);
        }
        return all;
    }
}
exports.MessageStore = MessageStore;
// =====================================================
// HELPER FUNCTIONS
// =====================================================
/**
 * Check apakah message adalah delete/revoke message
 */
const isDeleteMessage = (message) => {
    const content = message.message;
    if (!content)
        return false;
    return content.protocolMessage?.type === index_js_1.proto.Message.ProtocolMessage.Type.REVOKE;
};
exports.isDeleteMessage = isDeleteMessage;
/**
 * Get deleted message key dari revoke message
 */
const getDeletedMessageKey = (message) => {
    const content = message.message;
    if (!content)
        return null;
    const protoMsg = content.protocolMessage;
    if (protoMsg?.type !== index_js_1.proto.Message.ProtocolMessage.Type.REVOKE)
        return null;
    return protoMsg.key || null;
};
exports.getDeletedMessageKey = getDeletedMessageKey;
/**
 * Create anti-delete handler
 * Bisa dipasang ke sock.ev.on('messages.update')
 */
const createAntiDeleteHandler = (store) => {
    return (updates) => {
        const deletedMessages = [];
        for (const { key, update } of updates) {
            // Check if message was deleted
            if (update.messageStubType === index_js_1.proto.WebMessageInfo.StubType.REVOKE) {
                const deletedInfo = store.markAsDeleted(key, update.messageStubParameters?.[0]);
                if (deletedInfo) {
                    deletedMessages.push(deletedInfo);
                }
            }
        }
        return deletedMessages;
    };
};
exports.createAntiDeleteHandler = createAntiDeleteHandler;
/**
 * Create message store handler
 * Bisa dipasang ke sock.ev.on('messages.upsert')
 */
const createMessageStoreHandler = (store) => {
    return ({ messages }) => {
        // Filter out protocol messages
        const regularMessages = messages.filter(msg => {
            const content = msg.message;
            if (!content)
                return false;
            // Skip protocol messages (delete, read receipt, etc)
            if (content.protocolMessage)
                return false;
            if (content.senderKeyDistributionMessage)
                return false;
            return true;
        });
        store.storeMessages(regularMessages);
    };
};
exports.createMessageStoreHandler = createMessageStoreHandler;
exports.default = {
    MessageStore,
    isDeleteMessage: exports.isDeleteMessage,
    getDeletedMessageKey: exports.getDeletedMessageKey,
    createAntiDeleteHandler: exports.createAntiDeleteHandler,
    createMessageStoreHandler: exports.createMessageStoreHandler
};
