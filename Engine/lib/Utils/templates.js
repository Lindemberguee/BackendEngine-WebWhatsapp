"use strict"

Object.defineProperty(exports, "__esModule", { value: true })
exports.renderTemplate = exports.createTemplateManager = exports.PRESET_TEMPLATES = exports.TemplateManager = void 0

/**
 * Message Templates System
 * Ported from Baileys-Joss
 */

class TemplateManager {
    constructor() {
        this.templates = new Map()
    }

    generateId() {
        return `tpl_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    }

    extractVariables(content) {
        const regex = /\{\{(\w+)(?::([^}]*))?\}\}/g
        const variables = []
        const seen = new Set()
        let match

        while ((match = regex.exec(content)) !== null) {
            const name = match[1]
            if (!name) continue
            const defaultValue = match[2]

            if (!seen.has(name)) {
                seen.add(name)
                variables.push({
                    name,
                    defaultValue,
                    required: !defaultValue
                })
            }
        }

        return variables
    }

    create(options) {
        const template = {
            id: options.id ?? this.generateId(),
            name: options.name,
            content: options.content,
            description: options.description,
            category: options.category,
            variables: this.extractVariables(options.content),
            createdAt: new Date(),
            updatedAt: new Date()
        }

        this.templates.set(template.id, template)
        return template
    }

    get(id) {
        return this.templates.get(id)
    }

    getByName(name) {
        return Array.from(this.templates.values()).find(t => t.name === name)
    }

    getAll() {
        return Array.from(this.templates.values())
    }

    getByCategory(category) {
        return Array.from(this.templates.values()).filter(t => t.category === category)
    }

    update(id, updates) {
        const template = this.templates.get(id)
        if (!template) return undefined

        if (updates.content) {
            updates.variables = this.extractVariables(updates.content)
        }

        const updated = {
            ...template,
            ...updates,
            updatedAt: new Date()
        }

        this.templates.set(id, updated)
        return updated
    }

    delete(id) {
        return this.templates.delete(id)
    }

    render(id, data = {}) {
        const template = this.templates.get(id)
        if (!template) {
            throw new Error(`Template not found: ${id}`)
        }

        return this.renderContent(template.content, data)
    }

    renderContent(content, data = {}) {
        return content.replace(/\{\{(\w+)(?::([^}]*))?\}\}/g, (match, name, defaultValue) => {
            const value = data[name]
            if (value !== undefined && value !== null) {
                return String(value)
            }
            if (defaultValue !== undefined) {
                return defaultValue
            }
            return match
        })
    }

    validate(id, data) {
        const template = this.templates.get(id)
        if (!template) {
            throw new Error(`Template not found: ${id}`)
        }

        const missing = []
        for (const variable of template.variables) {
            if (variable.required && !(variable.name in data)) {
                missing.push(variable.name)
            }
        }

        return {
            valid: missing.length === 0,
            missing
        }
    }

    export() {
        return JSON.stringify(Array.from(this.templates.values()), null, 2)
    }

    import(json, overwrite = false) {
        const templates = JSON.parse(json)
        let imported = 0

        for (const template of templates) {
            if (!overwrite && this.templates.has(template.id)) {
                continue
            }
            this.templates.set(template.id, {
                ...template,
                createdAt: new Date(template.createdAt),
                updatedAt: new Date(template.updatedAt)
            })
            imported++
        }

        return imported
    }
}
exports.TemplateManager = TemplateManager

exports.PRESET_TEMPLATES = {
    ORDER_CONFIRMATION: {
        name: 'Order Confirmation',
        category: 'order',
        content: `✅ *Order Confirmed!*\n\nOrder ID: #{{orderId}}\nCustomer: {{customerName}}\nDate: {{orderDate}}\n\n📦 *Items:*\n{{items}}\n\n💰 *Total: Rp {{total}}*\n\nThank you for your order! 🙏`
    },
    ORDER_SHIPPED: {
        name: 'Order Shipped',
        category: 'order',
        content: `📦 *Your Order is On The Way!*\n\nOrder ID: #{{orderId}}\nTracking: {{trackingNumber}}\nCourier: {{courier}}\n\nEstimated delivery: {{estimatedDate}}\n\nTrack your package: {{trackingUrl:}}`
    },
    INVOICE: {
        name: 'Invoice',
        category: 'invoice',
        content: `📄 *INVOICE*\n\nInvoice #: {{invoiceNumber}}\nDate: {{invoiceDate}}\nDue Date: {{dueDate}}\n\n*Bill To:*\n{{customerName}}\n{{customerAddress:}}\n\n*Items:*\n{{items}}\n\nSubtotal: Rp {{subtotal}}\nTax ({{taxRate:11}}%): Rp {{tax}}\n*Total: Rp {{total}}*\n\nPayment Method: {{paymentMethod:Transfer Bank}}\nAccount: {{bankAccount:}}`
    },
    WELCOME: {
        name: 'Welcome Message',
        category: 'greeting',
        content: `👋 *Welcome, {{name}}!*\n\nThank you for joining {{companyName:us}}! \n\nWe're excited to have you. Here's what you can do:\n{{features:- Explore our products\n- Get exclusive offers\n- 24/7 support}}\n\nNeed help? Just reply to this message!`
    },
    BIRTHDAY: {
        name: 'Birthday Wishes',
        category: 'greeting',
        content: `🎂 *Happy Birthday, {{name}}!* 🎉\n\nWishing you a wonderful day filled with joy and happiness!\n\n🎁 As a special gift, here's {{discount:10}}% off your next purchase!\nUse code: {{code:BIRTHDAY{{year}}}}\n\nHave a great celebration! 🥳`
    },
    REMINDER: {
        name: 'Reminder',
        category: 'notification',
        content: `⏰ *Reminder*\n\nHi {{name}},\n\nThis is a friendly reminder about:\n📋 {{subject}}\n\n📅 Date: {{date}}\n🕐 Time: {{time}}\n📍 Location: {{location:TBD}}\n\n{{notes:}}\n\nDon't forget! 🙏`
    },
    APPOINTMENT: {
        name: 'Appointment Confirmation',
        category: 'notification',
        content: `📅 *Appointment Confirmed*\n\nHi {{name}},\n\nYour appointment has been scheduled:\n\n📋 Service: {{service}}\n📅 Date: {{date}}\n🕐 Time: {{time}}\n📍 Location: {{location}}\n\nPlease arrive 10 minutes early.\n\nNeed to reschedule? Reply to this message.`
    },
    SUPPORT_TICKET: {
        name: 'Support Ticket',
        category: 'support',
        content: `🎫 *Support Ticket Created*\n\nTicket #: {{ticketId}}\nSubject: {{subject}}\nPriority: {{priority:Normal}}\n\nHi {{name}},\n\nWe've received your request and our team is working on it.\n\nExpected response time: {{responseTime:24 hours}}\n\nThank you for your patience! 🙏`
    },
    SUPPORT_RESOLVED: {
        name: 'Support Resolved',
        category: 'support',
        content: `✅ *Issue Resolved*\n\nTicket #: {{ticketId}}\n\nHi {{name}},\n\nYour issue has been resolved:\n\n*Solution:*\n{{solution}}\n\nIf you need further assistance, please reply to this message.\n\nThank you! 🙏`
    }
}

const createTemplateManager = (includePresets = true) => {
    const manager = new TemplateManager()

    if (includePresets) {
        for (const [key, template] of Object.entries(exports.PRESET_TEMPLATES)) {
            manager.create({
                ...template,
                id: key.toLowerCase()
            })
        }
    }

    return manager
}
exports.createTemplateManager = createTemplateManager

const renderTemplate = (content, data = {}) => {
    return content.replace(/\{\{(\w+)(?::([^}]*))?\}\}/g, (match, name, defaultValue) => {
        const value = data[name]
        if (value !== undefined && value !== null) {
            return String(value)
        }
        if (defaultValue !== undefined) {
            return defaultValue
        }
        return match
    })
}
exports.renderTemplate = renderTemplate
