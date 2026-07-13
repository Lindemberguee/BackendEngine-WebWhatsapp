"use strict"

Object.defineProperty(exports, "__esModule", { value: true })
exports.createReadReceiptController = exports.createPinnedMessagesManager = exports.createTypingIndicator = exports.DISAPPEARING_DURATIONS = exports.PinnedMessagesManager = exports.TypingIndicator = void 0

/**
 * Chat Control Utilities
 * Ported from Baileys-Joss: TypingIndicator, ReadReceiptController, PinnedMessagesManager.
 */

/**
 * Standard disappearing-message duration constants (in seconds).
 */
const DISAPPEARING_DURATIONS = {
    OFF:     0,
    HOURS_24: 86400,
    DAYS_7:  604800,
    DAYS_90: 7776000
}
exports.DISAPPEARING_DURATIONS = DISAPPEARING_DURATIONS

/**
 * Typing / recording presence indicator helper.
 *
 * Wire in sock.sendPresenceUpdate to show/hide the "typing..." bubble.
 *
 * @example
 * const typing = createTypingIndicator(
 *     (jid, presence) => sock.sendPresenceUpdate(presence, jid)
 * )
 *
 * // Simple — show typing for 2 s then send
 * await typing.simulateTyping(jid, 2000, () => sock.sendMessage(jid, { text: 'Hello!' }))
 *
 * // Manual control
 * await typing.startTyping(jid, { duration: 3000 })  // auto-pauses after 3 s
 * await typing.stopTyping(jid)
 *
 * // Voice note indicator
 * await typing.startRecording(jid, { duration: 2000 })
 */
class TypingIndicator {
    constructor(sendPresence) {
        this.intervals   = new Map()
        this.sendPresence = sendPresence
    }

    /**
     * Start the composing (typing) indicator.
     * @param {string} jid
     * @param {{ duration?: number, autoPause?: boolean }} [options]
     */
    async startTyping(jid, options = {}) {
        this.stopTyping(jid) // clear any existing timer for this JID
        await this.sendPresence(jid, 'composing')

        if (options.autoPause !== false && options.duration) {
            const timeout = setTimeout(() => this.stopTyping(jid), options.duration)
            this.intervals.set(jid, timeout)
        }
    }

    /**
     * Start the recording (voice note) indicator.
     * @param {string} jid
     * @param {{ duration?: number, autoPause?: boolean }} [options]
     */
    async startRecording(jid, options = {}) {
        this.stopTyping(jid)
        await this.sendPresence(jid, 'recording')

        if (options.autoPause !== false && options.duration) {
            const timeout = setTimeout(() => this.stopTyping(jid), options.duration)
            this.intervals.set(jid, timeout)
        }
    }

    /**
     * Stop the typing / recording indicator for a JID.
     * @param {string} jid
     */
    async stopTyping(jid) {
        const existing = this.intervals.get(jid)
        if (existing) {
            clearTimeout(existing)
            this.intervals.delete(jid)
        }
        try {
            await this.sendPresence(jid, 'paused')
        } catch {}
    }

    /** Stop all active typing indicators. */
    async stopAll() {
        for (const [jid] of this.intervals) {
            await this.stopTyping(jid)
        }
    }

    /**
     * Show "typing..." for `duration` ms, run `callback`, then return its result.
     *
     * @template T
     * @param {string}           jid
     * @param {number}           duration  - How long to show the indicator (ms)
     * @param {() => Promise<T>} callback  - Action to run after the delay
     * @returns {Promise<T>}
     *
     * @example
     * const sent = await typing.simulateTyping(jid, 1500, () =>
     *     sock.sendMessage(jid, { text: 'Here is your answer!' })
     * )
     */
    async simulateTyping(jid, duration, callback) {
        await this.startTyping(jid)
        await new Promise(r => setTimeout(r, duration))
        await this.stopTyping(jid)
        return callback()
    }
}

exports.TypingIndicator = TypingIndicator

/**
 * Client-side pinned messages tracker.
 * (WhatsApp protocol sends pin events via `messages.update`; this class stores them locally.)
 */
class PinnedMessagesManager {
    constructor() {
        this.pinnedMessages = new Map()
    }

    pin(jid, messageId, pinnedBy, expiresAt) {
        const pinned = { messageId, jid, pinnedAt: new Date(), pinnedBy, expiresAt }
        const existing = this.pinnedMessages.get(jid) || []
        const filtered = existing.filter(p => p.messageId !== messageId)
        filtered.push(pinned)
        this.pinnedMessages.set(jid, filtered)
        return pinned
    }

    unpin(jid, messageId) {
        const existing = this.pinnedMessages.get(jid)
        if (!existing) return false
        const filtered = existing.filter(p => p.messageId !== messageId)
        if (filtered.length === existing.length) return false
        this.pinnedMessages.set(jid, filtered)
        return true
    }

    getPinned(jid) {
        return this.pinnedMessages.get(jid) || []
    }

    isPinned(jid, messageId) {
        return (this.pinnedMessages.get(jid) || []).some(p => p.messageId === messageId)
    }

    clearPins(jid) {
        this.pinnedMessages.delete(jid)
    }

    clearExpired() {
        let cleared = 0
        const now = Date.now()
        for (const [jid, pins] of this.pinnedMessages) {
            const valid = pins.filter(p => !p.expiresAt || p.expiresAt.getTime() > now)
            if (valid.length < pins.length) {
                cleared += pins.length - valid.length
                this.pinnedMessages.set(jid, valid)
            }
        }
        return cleared
    }
}

exports.PinnedMessagesManager = PinnedMessagesManager

/** Factory — create a TypingIndicator */
const createTypingIndicator = (sendPresence) => new TypingIndicator(sendPresence)
exports.createTypingIndicator = createTypingIndicator

/** Factory — create a PinnedMessagesManager */
const createPinnedMessagesManager = () => new PinnedMessagesManager()
exports.createPinnedMessagesManager = createPinnedMessagesManager

/**
 * Create read receipt controller
 */
const createReadReceiptController = (sendReadReceipt, config = { enabled: true }) => {
    let currentConfig = { ...config }

    return {
        setConfig(newConfig) {
            currentConfig = { ...currentConfig, ...newConfig }
        },
        getConfig() {
            return { ...currentConfig }
        },
        enable() {
            currentConfig.enabled = true
        },
        disable() {
            currentConfig.enabled = false
        },
        isEnabled() {
            return currentConfig.enabled
        },
        async markRead(jid, participant, messageIds) {
            if (!currentConfig.enabled) return
            if (currentConfig.excludeJids?.includes(jid)) return

            if (currentConfig.readDelay) {
                await new Promise(r => setTimeout(r, currentConfig.readDelay))
            }

            await sendReadReceipt(jid, participant, messageIds)
        },
        async forceMarkRead(jid, participant, messageIds) {
            await sendReadReceipt(jid, participant, messageIds)
        }
    }
}
exports.createReadReceiptController = createReadReceiptController
