"use strict"

Object.defineProperty(exports, "__esModule", { value: true })
exports.createAutoReply = exports.AutoReplyHandler = void 0

/**
 * Auto Reply System
 * Ported from Baileys-Joss: keyword/pattern-based automatic response handler.
 *
 * Features:
 *  - Rule matching by keywords, regex pattern, or exact text
 *  - Per-rule and global cooldowns
 *  - simulateTyping — shows "typing..." indicator before sending reply
 *  - typingDuration — how long to show the indicator (default: 1000 ms)
 *  - Group-only / private-only filters, allow/block JID lists
 *  - Priority ordering and optional multi-match
 *  - Dynamic responses via callback functions
 */
class AutoReplyHandler {
    constructor(sendMessage, sendPresence, options = {}) {
        this.rules        = new Map()
        this.cooldowns    = new Map()
        this.globalCooldown = new Map()

        this.sendMessage  = sendMessage
        this.sendPresence = sendPresence
        this.options = {
            globalCooldown: options.globalCooldown ?? 1000,
            simulateTyping: options.simulateTyping ?? false,
            typingDuration: options.typingDuration ?? 1000,
            multiMatch:     options.multiMatch     ?? false,
            onReply:        options.onReply        ?? (() => {}),
            onError:        options.onError        ?? (() => {})
        }
    }

    /** Generate unique ID for a rule */
    generateId() {
        return `ar_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    }

    /**
     * Add an auto-reply rule.
     * Rule must have at least one of: keywords, pattern, or exactMatch.
     */
    addRule(rule) {
        const fullRule = {
            ...rule,
            id:       rule.id       ?? this.generateId(),
            active:   rule.active   ?? true,
            priority: rule.priority ?? 0
        }

        if (!fullRule.keywords && !fullRule.pattern && !fullRule.exactMatch) {
            throw new Error('Rule must have at least one of: keywords, pattern, or exactMatch')
        }

        this.rules.set(fullRule.id, fullRule)
        return fullRule
    }

    /** Remove a rule by ID */
    removeRule(id) {
        return this.rules.delete(id)
    }

    /** Get all registered rules */
    getRules() {
        return Array.from(this.rules.values())
    }

    /** Get a rule by ID */
    getRule(id) {
        return this.rules.get(id)
    }

    /** Enable or disable a rule */
    setRuleActive(id, active) {
        const rule = this.rules.get(id)
        if (rule) {
            rule.active = active
            return true
        }
        return false
    }

    /** Remove all rules */
    clearRules() {
        this.rules.clear()
    }

    /** @private Check per-rule cooldown for a JID */
    checkCooldown(ruleId, jid) {
        const key      = `${ruleId}:${jid}`
        const lastTime = this.cooldowns.get(key) ?? 0
        return Date.now() - lastTime > 0
    }

    /** @private Check global cooldown for a JID */
    checkGlobalCooldown(jid) {
        const lastTime = this.globalCooldown.get(jid) ?? 0
        return Date.now() - lastTime > this.options.globalCooldown
    }

    /** @private Set cooldown state */
    setCooldown(ruleId, jid, cooldown) {
        const key = `${ruleId}:${jid}`
        this.cooldowns.set(key, Date.now() + cooldown)
        this.globalCooldown.set(jid, Date.now())
    }

    /** @private Match incoming text against a rule */
    matchRule(text, rule) {
        if (!rule.active) return null

        if (rule.exactMatch) {
            if (text.toLowerCase() === rule.exactMatch.toLowerCase()) {
                return [text]
            }
        }

        if (rule.keywords && rule.keywords.length > 0) {
            const lower = text.toLowerCase()
            for (const kw of rule.keywords) {
                if (lower.includes(kw.toLowerCase())) return [kw]
            }
        }

        if (rule.pattern) {
            return text.match(rule.pattern)
        }

        return null
    }

    /** @private Check JID filters for a rule */
    isJidAllowed(jid, rule) {
        const isGroup      = jid.endsWith('@g.us')
        const isNewsletter = jid.endsWith('@newsletter')

        if (isNewsletter) return false
        if (rule.groupsOnly   && !isGroup)  return false
        if (rule.privateOnly  &&  isGroup)  return false

        if (rule.allowedJids && rule.allowedJids.length > 0) {
            if (!rule.allowedJids.includes(jid)) return false
        }
        if (rule.blockedJids && rule.blockedJids.includes(jid)) {
            return false
        }

        return true
    }

    /**
     * Process an incoming WAMessage and send an auto-reply if a rule matches.
     * Returns true if at least one reply was sent.
     */
    async processMessage(message) {
        const messageContent = message.message
        if (!messageContent) return false

        const text =
            messageContent.conversation                    ||
            messageContent.extendedTextMessage?.text       ||
            messageContent.imageMessage?.caption           ||
            messageContent.videoMessage?.caption           ||
            messageContent.documentMessage?.caption        ||
            ''

        if (!text) return false

        const jid = message.key.remoteJid
        if (!jid) return false

        if (!this.checkGlobalCooldown(jid)) return false

        // Sort by priority descending
        const sortedRules = Array.from(this.rules.values())
            .filter(r => r.active)
            .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

        let matched = false

        for (const rule of sortedRules) {
            if (!this.isJidAllowed(jid, rule)) continue
            if (rule.cooldown && !this.checkCooldown(rule.id, jid)) continue

            const match = this.matchRule(text, rule)
            if (!match) continue

            try {
                // Resolve response (static or function)
                let response
                if (typeof rule.response === 'function') {
                    response = await rule.response(message, match)
                } else {
                    response = rule.response
                }

                // Show typing indicator before sending reply
                if (this.options.simulateTyping && this.sendPresence) {
                    await this.sendPresence(jid, 'composing')
                    await new Promise(r => setTimeout(r, this.options.typingDuration))
                    await this.sendPresence(jid, 'paused')
                }

                // Send the reply
                await this.sendMessage(jid, response, rule.quoted ? { quoted: message } : undefined)

                if (rule.cooldown) {
                    this.setCooldown(rule.id, jid, rule.cooldown)
                }

                this.options.onReply(rule, message, response)
                matched = true

                if (!this.options.multiMatch) break

            } catch (error) {
                this.options.onError(error, rule, message)
            }
        }

        return matched
    }
}

exports.AutoReplyHandler = AutoReplyHandler

/**
 * Factory — create an AutoReplyHandler instance.
 *
 * @param {Function} sendMessage   (jid, content, options?) => Promise<WAMessage|undefined>
 * @param {Function} [sendPresence] (jid, presence) => Promise<void>  — required for simulateTyping
 * @param {AutoReplyOptions} [options]
 *
 * @example
 * const autoReply = createAutoReply(
 *     (jid, content, opts) => sock.sendMessage(jid, content, opts),
 *     (jid, presence)      => sock.sendPresenceUpdate(presence, jid),
 *     {
 *         simulateTyping: true,
 *         typingDuration: 1500,
 *         globalCooldown: 2000,
 *         onReply: (rule, msg, response) => console.log(`Rule "${rule.id}" matched`)
 *     }
 * )
 *
 * autoReply.addRule({
 *     keywords: ['hi', 'hello'],
 *     response: { text: 'Hello! How can I help you? 👋' },
 *     quoted:   true
 * })
 *
 * // In your message event:
 * sock.ev.on('messages.upsert', async ({ messages }) => {
 *     for (const msg of messages) {
 *         if (!msg.key.fromMe) await autoReply.processMessage(msg)
 *     }
 * })
 */
const createAutoReply = (sendMessage, sendPresence, options) => {
    return new AutoReplyHandler(sendMessage, sendPresence, options)
}

exports.createAutoReply = createAutoReply
