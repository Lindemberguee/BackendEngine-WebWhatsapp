"use strict"

Object.defineProperty(exports, "__esModule", { value: true })
exports.createMessageScheduler = exports.MessageScheduler = void 0

/**
 * Message Scheduling System
 * Ported from Baileys-Joss: schedule messages to be sent automatically at specific times.
 *
 * Features:
 *  - schedule(jid, content, Date)          — send at an absolute time
 *  - scheduleDelay(jid, content, delayMs)  — send after N milliseconds
 *  - cancel(id)                            — cancel by ID
 *  - cancelForJid(jid)                     — cancel all pending for a JID
 *  - getPending()                          — list all pending messages
 *  - get(id)                               — get a single scheduled entry
 *  - clearAll()                            — wipe the whole queue
 *  - stop()                                — stop the internal timer
 *  - start()                               — restart the timer (queue must be non-empty)
 */
class MessageScheduler {
    constructor(sendMessage, options = {}) {
        this.queue = new Map()
        this.timer = null
        this.sendMessage = sendMessage
        this.options = {
            maxQueue:      options.maxQueue      ?? 1000,
            checkInterval: options.checkInterval ?? 1000,
            onSent:        options.onSent        ?? (() => {}),
            onFailed:      options.onFailed      ?? (() => {})
        }
    }

    /** Generate a unique ID for a scheduled message */
    generateId() {
        return `sched_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    }

    /**
     * Schedule a message to be sent at a specific Date/time.
     * @param {string}             jid           - Recipient JID
     * @param {AnyMessageContent}  content       - Message content
     * @param {Date}               scheduledTime - When to send (must be in the future)
     * @returns {ScheduledMessage}
     */
    schedule(jid, content, scheduledTime) {
        if (this.queue.size >= this.options.maxQueue) {
            throw new Error(`Maximum queue size (${this.options.maxQueue}) reached`)
        }

        if (scheduledTime.getTime() <= Date.now()) {
            throw new Error('Scheduled time must be in the future')
        }

        const scheduled = {
            id:            this.generateId(),
            jid,
            content,
            scheduledTime,
            createdAt:     new Date(),
            status:        'pending'
        }

        this.queue.set(scheduled.id, scheduled)
        this.ensureTimerRunning()

        return scheduled
    }

    /**
     * Schedule a message with a delay from now.
     * @param {string}            jid      - Recipient JID
     * @param {AnyMessageContent} content  - Message content
     * @param {number}            delayMs  - Delay in milliseconds
     * @returns {ScheduledMessage}
     */
    scheduleDelay(jid, content, delayMs) {
        const scheduledTime = new Date(Date.now() + delayMs)
        return this.schedule(jid, content, scheduledTime)
    }

    /**
     * Cancel a scheduled message by its ID.
     * @param {string} id
     * @returns {boolean} true if cancelled, false if not found or already sent
     */
    cancel(id) {
        const scheduled = this.queue.get(id)
        if (scheduled && scheduled.status === 'pending') {
            scheduled.status = 'cancelled'
            this.queue.delete(id)
            return true
        }
        return false
    }

    /**
     * Cancel all pending messages for a specific JID.
     * @param {string} jid
     * @returns {number} number of messages cancelled
     */
    cancelForJid(jid) {
        let cancelled = 0
        for (const [id, scheduled] of this.queue) {
            if (scheduled.jid === jid && scheduled.status === 'pending') {
                scheduled.status = 'cancelled'
                this.queue.delete(id)
                cancelled++
            }
        }
        return cancelled
    }

    /**
     * Get all pending scheduled messages.
     * @returns {ScheduledMessage[]}
     */
    getPending() {
        return Array.from(this.queue.values()).filter(s => s.status === 'pending')
    }

    /**
     * Get a scheduled message by ID.
     * @param {string} id
     * @returns {ScheduledMessage|undefined}
     */
    get(id) {
        return this.queue.get(id)
    }

    /**
     * Clear all pending messages and stop the timer.
     * @returns {number} number of messages cleared
     */
    clearAll() {
        const count = this.queue.size
        this.queue.clear()
        this.stopTimer()
        return count
    }

    /** Process the queue and send any due messages */
    async processQueue() {
        const now = Date.now()

        for (const [id, scheduled] of this.queue) {
            if (scheduled.status !== 'pending') continue
            if (scheduled.scheduledTime.getTime() > now) continue

            try {
                const message = await this.sendMessage(scheduled.jid, scheduled.content)
                scheduled.status  = 'sent'
                scheduled.messageId = message?.key?.id ?? undefined
                this.options.onSent(scheduled, message)
            } catch (error) {
                scheduled.status = 'failed'
                scheduled.error  = error.message
                this.options.onFailed(scheduled, error)
            }

            this.queue.delete(id)
        }

        // Auto-stop when nothing is left
        if (this.queue.size === 0) {
            this.stopTimer()
        }
    }

    ensureTimerRunning() {
        if (!this.timer) {
            this.timer = setInterval(() => this.processQueue(), this.options.checkInterval)
        }
    }

    stopTimer() {
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
    }

    /** Stop the scheduler (timer is cleared; already scheduled entries remain in queue) */
    stop() {
        this.stopTimer()
    }

    /**
     * (Re)start the scheduler — only has effect if the queue is non-empty.
     * The scheduler auto-starts whenever `schedule()` or `scheduleDelay()` is called,
     * so you only need this after an explicit `stop()`.
     */
    start() {
        if (this.queue.size > 0) {
            this.ensureTimerRunning()
        }
    }
}

exports.MessageScheduler = MessageScheduler

/**
 * Factory helper — creates and returns a ready-to-use MessageScheduler.
 *
 * @param {(jid: string, content: AnyMessageContent) => Promise<WAMessage|undefined>} sendMessage
 * @param {SchedulerOptions} [options]
 * @returns {MessageScheduler}
 *
 * @example
 * const scheduler = createMessageScheduler(
 *     (jid, content) => sock.sendMessage(jid, content),
 *     {
 *         onSent:   (s, msg) => console.log(`Sent to ${s.jid}`),
 *         onFailed: (s, err) => console.error(`Failed: ${err.message}`)
 *     }
 * )
 *
 * // Schedule for a specific time
 * const entry = scheduler.schedule(jid, { text: 'Happy Birthday! 🎂' }, new Date('2026-12-25T09:00:00'))
 *
 * // Schedule with a delay (30 minutes)
 * scheduler.scheduleDelay(jid, { text: 'Reminder!' }, 30 * 60 * 1000)
 *
 * // Cancel one message
 * scheduler.cancel(entry.id)
 *
 * // Cancel all messages for a JID
 * scheduler.cancelForJid(jid)
 *
 * // Get all pending entries
 * const pending = scheduler.getPending()
 *
 * // Stop (timer cleared, queue preserved)
 * scheduler.stop()
 *
 * // Restart after stop
 * scheduler.start()
 *
 * // Wipe everything
 * scheduler.clearAll()
 */
const createMessageScheduler = (sendMessage, options) => {
    return new MessageScheduler(sendMessage, options)
}

exports.createMessageScheduler = createMessageScheduler
