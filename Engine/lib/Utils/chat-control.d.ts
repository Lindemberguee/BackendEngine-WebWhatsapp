/** Standard disappearing-message durations in seconds */
export declare const DISAPPEARING_DURATIONS: {
    readonly OFF:      0
    readonly HOURS_24: 86400
    readonly DAYS_7:   604800
    readonly DAYS_90:  7776000
}

export interface TypingOptions {
    /** How long to show the indicator before auto-pausing (ms) */
    duration?: number
    /** Auto-pause after duration (default: true) */
    autoPause?: boolean
}

/**
 * Typing / recording presence indicator helper.
 *
 * @example
 * ```ts
 * import { createTypingIndicator } from '@innovatorssoft/baileys'
 *
 * const typing = createTypingIndicator(
 *     (jid, presence) => sock.sendPresenceUpdate(presence, jid)
 * )
 *
 * // Simulate typing, then send
 * await typing.simulateTyping(jid, 1500, () =>
 *     sock.sendMessage(jid, { text: 'Here is your answer!' })
 * )
 *
 * // Manual control
 * await typing.startTyping(jid, { duration: 3000 })
 * await typing.stopTyping(jid)
 *
 * // Voice note indicator
 * await typing.startRecording(jid, { duration: 2000 })
 * ```
 */
export declare class TypingIndicator {
    constructor(sendPresence: (jid: string, presence: 'composing' | 'paused' | 'recording') => Promise<void>)

    /** Show the "typing..." composing indicator */
    startTyping(jid: string, options?: TypingOptions): Promise<void>

    /** Show the recording indicator (for voice notes) */
    startRecording(jid: string, options?: TypingOptions): Promise<void>

    /** Stop typing/recording and send 'paused' */
    stopTyping(jid: string): Promise<void>

    /** Stop all active indicators */
    stopAll(): Promise<void>

    /**
     * Show "typing..." for `duration` ms, run `callback`, then return its result.
     * This is the core helper used by AutoReplyHandler's `simulateTyping` option.
     */
    simulateTyping<T>(jid: string, duration: number, callback: () => Promise<T>): Promise<T>
}

export interface PinnedMessage {
    messageId: string
    jid: string
    pinnedAt: Date
    pinnedBy?: string
    expiresAt?: Date
}

/** Client-side pinned-message tracker */
export declare class PinnedMessagesManager {
    pin(jid: string, messageId: string, pinnedBy?: string, expiresAt?: Date): PinnedMessage
    unpin(jid: string, messageId: string): boolean
    getPinned(jid: string): PinnedMessage[]
    isPinned(jid: string, messageId: string): boolean
    clearPins(jid: string): void
    clearExpired(): number
}

/** Create a TypingIndicator wired to your socket's sendPresenceUpdate */
export declare const createTypingIndicator: (
    sendPresence: (jid: string, presence: 'composing' | 'paused' | 'recording') => Promise<void>
) => TypingIndicator

/** Create a PinnedMessagesManager */
export declare const createPinnedMessagesManager: () => PinnedMessagesManager

export interface ReadReceiptConfig {
    /** Enable read receipts (blue ticks) */
    enabled: boolean
    /** Auto-read messages (if you write an auto-read loop) */
    autoRead?: boolean
    /** Delay before marking as read (ms) */
    readDelay?: number
    /** JIDs that should stay unread */
    excludeJids?: string[]
}

/**
 * Creates a ReadReceiptController that wraps sock.readMessages and holds state/configuration.
 */
export declare const createReadReceiptController: (
    sendReadReceipt: (jid: string, participant: string | undefined, messageIds: string[]) => Promise<void>,
    config?: ReadReceiptConfig
) => {
    setConfig(newConfig: Partial<ReadReceiptConfig>): void
    getConfig(): ReadReceiptConfig
    enable(): void
    disable(): void
    isEnabled(): boolean
    markRead(jid: string, participant: string | undefined, messageIds: string[]): Promise<void>
    forceMarkRead(jid: string, participant: string | undefined, messageIds: string[]): Promise<void>
}
