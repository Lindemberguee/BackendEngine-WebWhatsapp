import type { AnyMessageContent, WAMessage } from '../Types'

/** A single auto-reply rule */
export interface AutoReplyRule {
    id: string
    /** Keywords to match (case-insensitive substring match) */
    keywords?: string[]
    /** Regex pattern to match */
    pattern?: RegExp
    /** Exact text match (case-insensitive) */
    exactMatch?: string
    /** Static reply content, or a function returning content dynamically */
    response: AnyMessageContent | ((message: WAMessage, match: RegExpMatchArray | null) => AnyMessageContent | Promise<AnyMessageContent>)
    /** Only allow replies to these JIDs */
    allowedJids?: string[]
    /** Block replies to these JIDs */
    blockedJids?: string[]
    /** Only reply in groups */
    groupsOnly?: boolean
    /** Only reply in private chats */
    privateOnly?: boolean
    /** Per-rule cooldown in ms */
    cooldown?: number
    /** Quote the original message in the reply */
    quoted?: boolean
    /** Whether this rule is active (default: true) */
    active?: boolean
    /** Priority — higher number = checked first (default: 0) */
    priority?: number
}

/** Options for the AutoReplyHandler */
export interface AutoReplyOptions {
    /** Minimum time between replies to any JID in ms (default: 1000) */
    globalCooldown?: number
    /**
     * Show a "typing..." composing indicator before sending each reply.
     * Requires `sendPresence` to be passed to `createAutoReply`.
     */
    simulateTyping?: boolean
    /** How long to show the typing indicator in ms (default: 1000) */
    typingDuration?: number
    /** Send a reply for every matching rule (default: false — first match only) */
    multiMatch?: boolean
    /** Called after each auto-reply is sent */
    onReply?: (rule: AutoReplyRule, message: WAMessage, response: AnyMessageContent) => void
    /** Called when a rule's reply throws an error */
    onError?: (error: Error, rule: AutoReplyRule, message: WAMessage) => void
}

export type AutoReplySendFunction = (
    jid: string,
    content: AnyMessageContent,
    options?: { quoted?: WAMessage }
) => Promise<WAMessage | undefined>

export type PresenceFunction = (jid: string, presence: 'composing' | 'paused') => Promise<void>

/** Keyword/pattern-based automatic reply handler */
export declare class AutoReplyHandler {
    constructor(
        sendMessage: AutoReplySendFunction,
        sendPresence?: PresenceFunction,
        options?: AutoReplyOptions
    )

    /** Add a rule. Must have at least one of: keywords, pattern, exactMatch */
    addRule(rule: Omit<AutoReplyRule, 'id'> & { id?: string }): AutoReplyRule

    /** Remove a rule by ID */
    removeRule(id: string): boolean

    /** List all rules */
    getRules(): AutoReplyRule[]

    /** Get a rule by ID */
    getRule(id: string): AutoReplyRule | undefined

    /** Enable or disable a rule */
    setRuleActive(id: string, active: boolean): boolean

    /** Remove all rules */
    clearRules(): void

    /**
     * Process an incoming WAMessage and auto-reply if a rule matches.
     * @returns true if at least one reply was sent
     */
    processMessage(message: WAMessage): Promise<boolean>
}

/**
 * Create an AutoReplyHandler.
 *
 * @param sendMessage    - Wire to `(jid, content, opts) => sock.sendMessage(jid, content, opts)`
 * @param sendPresence   - Wire to `(jid, presence) => sock.sendPresenceUpdate(presence, jid)` — required for `simulateTyping`
 * @param options        - Handler options including `simulateTyping` and `typingDuration`
 *
 * @example
 * ```ts
 * import { createAutoReply } from '@innovatorssoft/baileys'
 *
 * const autoReply = createAutoReply(
 *     (jid, content, opts) => sock.sendMessage(jid, content, opts),
 *     (jid, presence)      => sock.sendPresenceUpdate(presence, jid),
 *     { simulateTyping: true, typingDuration: 1500 }
 * )
 *
 * autoReply.addRule({ keywords: ['hi', 'hello'], response: { text: 'Hello! 👋' }, quoted: true })
 *
 * sock.ev.on('messages.upsert', async ({ messages }) => {
 *     for (const msg of messages) {
 *         if (!msg.key.fromMe) await autoReply.processMessage(msg)
 *     }
 * })
 * ```
 */
export declare const createAutoReply: (
    sendMessage: AutoReplySendFunction,
    sendPresence?: PresenceFunction,
    options?: AutoReplyOptions
) => AutoReplyHandler
