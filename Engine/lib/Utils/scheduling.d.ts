import type { AnyMessageContent, WAMessage } from '../Types'

/** A single scheduled message entry */
export interface ScheduledMessage {
    /** Unique ID (e.g. `sched_1712400000000_a3f2b1c`) */
    id: string
    /** Recipient JID */
    jid: string
    /** Message content */
    content: AnyMessageContent
    /** When the message will be sent */
    scheduledTime: Date
    /** When the entry was created */
    createdAt: Date
    /** Current status */
    status: 'pending' | 'sent' | 'failed' | 'cancelled'
    /** Error message if status is 'failed' */
    error?: string
    /** WhatsApp message ID after successful send */
    messageId?: string
}

/** Options for the scheduler */
export interface SchedulerOptions {
    /** Maximum number of pending messages allowed in the queue (default: 1000) */
    maxQueue?: number
    /** How often (ms) the queue is checked for due messages (default: 1000) */
    checkInterval?: number
    /** Called when a message is successfully sent */
    onSent?: (scheduled: ScheduledMessage, message: WAMessage) => void
    /** Called when a message fails to send */
    onFailed?: (scheduled: ScheduledMessage, error: Error) => void
}

/** The function signature expected by the scheduler to send messages */
export type SendMessageFunction = (jid: string, content: AnyMessageContent) => Promise<WAMessage | undefined>

/**
 * In-memory message scheduler.
 * Auto-starts the internal timer when messages are scheduled,
 * and auto-stops when the queue becomes empty.
 */
export declare class MessageScheduler {
    constructor(sendMessage: SendMessageFunction, options?: SchedulerOptions)

    /**
     * Schedule a message to be sent at a specific Date.
     * @throws if `scheduledTime` is not in the future
     * @throws if the queue is full
     */
    schedule(jid: string, content: AnyMessageContent, scheduledTime: Date): ScheduledMessage

    /**
     * Schedule a message with a delay from now.
     * @param delayMs - Delay in milliseconds (e.g. `30 * 60 * 1000` = 30 minutes)
     */
    scheduleDelay(jid: string, content: AnyMessageContent, delayMs: number): ScheduledMessage

    /**
     * Cancel a pending message by ID.
     * @returns `true` if the message was found and cancelled
     */
    cancel(id: string): boolean

    /**
     * Cancel all pending messages for a specific JID.
     * @returns number of messages cancelled
     */
    cancelForJid(jid: string): number

    /** Get all currently pending scheduled messages */
    getPending(): ScheduledMessage[]

    /** Get a specific scheduled message by ID */
    get(id: string): ScheduledMessage | undefined

    /**
     * Clear all pending messages and stop the timer.
     * @returns number of entries cleared
     */
    clearAll(): number

    /** Stop the internal check timer. Already-queued messages are preserved. */
    stop(): void

    /**
     * (Re)start the timer. Only has effect if the queue is non-empty.
     * The scheduler auto-starts on `schedule()` / `scheduleDelay()`, so you
     * only need this after an explicit `stop()`.
     */
    start(): void
}

/**
 * Create a ready-to-use MessageScheduler.
 *
 * @example
 * ```ts
 * import { createMessageScheduler } from '@innovatorssoft/baileys'
 *
 * const scheduler = createMessageScheduler(
 *     (jid, content) => sock.sendMessage(jid, content),
 *     {
 *         onSent:   (s, msg) => console.log(`Sent to ${s.jid}`),
 *         onFailed: (s, err) => console.error(`Failed: ${err.message}`)
 *     }
 * )
 *
 * // Schedule at a specific time
 * const entry = scheduler.schedule(jid, { text: 'Happy Birthday! 🎂' }, new Date('2026-12-25T09:00:00'))
 *
 * // Schedule with delay (30 minutes from now)
 * scheduler.scheduleDelay(jid, { text: 'Reminder!' }, 30 * 60 * 1000)
 *
 * // Cancel one
 * scheduler.cancel(entry.id)
 *
 * // Cancel all for a JID
 * scheduler.cancelForJid(jid)
 *
 * // View pending
 * const pending = scheduler.getPending()
 *
 * // Stop/start
 * scheduler.stop()
 * scheduler.start()
 *
 * // Wipe everything
 * scheduler.clearAll()
 * ```
 */
export declare const createMessageScheduler: (
    sendMessage: SendMessageFunction,
    options?: SchedulerOptions
) => MessageScheduler
