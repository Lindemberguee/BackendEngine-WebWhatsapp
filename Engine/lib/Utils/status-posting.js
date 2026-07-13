"use strict"

Object.defineProperty(exports, "__esModule", { value: true })
exports.StatusHelper = exports.getStatusJid = exports.STATUS_BROADCAST_JID = exports.createAudioStatus = exports.createVideoStatus = exports.createImageStatus = exports.createTextStatus = exports.generateStatusMessageId = exports.STATUS_FONTS = exports.STATUS_BACKGROUNDS = void 0

const crypto_1 = require("crypto")

/**
 * Pre-defined background colors for text status
 */
exports.STATUS_BACKGROUNDS = {
    solid: {
        green: '#25D366',
        blue: '#34B7F1',
        purple: '#8B5CF6',
        red: '#EF4444',
        orange: '#F97316',
        yellow: '#EAB308',
        pink: '#EC4899',
        teal: '#14B8A6',
        gray: '#6B7280',
        black: '#000000',
        white: '#FFFFFF'
    },
    gradient: {
        sunset: ['#F97316', '#EF4444'],
        ocean: ['#3B82F6', '#06B6D4'],
        forest: ['#22C55E', '#10B981'],
        purple: ['#8B5CF6', '#EC4899'],
        midnight: ['#1E3A8A', '#4C1D95'],
        aurora: ['#06B6D4', '#8B5CF6', '#EC4899']
    }
}

/**
 * Font types for text status (0-9)
 */
exports.STATUS_FONTS = {
    SANS_SERIF: 0,
    SERIF: 1,
    NORICAN: 2,
    BRYNDAN: 3,
    BEBASNEUE: 4,
    OSWALD: 5,
    DAMION: 6,
    DANCING: 7,
    COMFORTAA: 8,
    EXOTWO: 9
}

/**
 * Generate a typical WhatsApp status message ID starting with 3EB0
 */
const generateStatusMessageId = () => {
    return `3EB0${(0, crypto_1.randomBytes)(16).toString('hex').toUpperCase()}`
}
exports.generateStatusMessageId = generateStatusMessageId

/** Create text status content */
const createTextStatus = (options) => {
    const backgroundColor = options.backgroundColor || exports.STATUS_BACKGROUNDS.solid.green
    const font = options.font ?? exports.STATUS_FONTS.SANS_SERIF
    const textColor = options.textColor || '#FFFFFF'

    return {
        text: options.text,
        backgroundColor,
        font,
        textColor,
        contextInfo: {
            mentionedJid: options.mentions || [],
            isForwarded: false
        }
    }
}
exports.createTextStatus = createTextStatus

/** Create image status content */
const createImageStatus = (media, options) => {
    return {
        image: typeof media === 'string' ? { url: media } : media,
        caption: options?.caption || ''
    }
}
exports.createImageStatus = createImageStatus

/** Create video status content */
const createVideoStatus = (media, options) => {
    return {
        video: typeof media === 'string' ? { url: media } : media,
        caption: options?.caption || '',
        gifPlayback: options?.gifPlayback || false
    }
}
exports.createVideoStatus = createVideoStatus

/** Create audio/PTT status content */
const createAudioStatus = (media, options) => {
    return {
        audio: typeof media === 'string' ? { url: media } : media,
        ptt: true, // Status audio is always PTT style
        mimetype: 'audio/ogg; codecs=opus',
        waveform: options?.waveform
    }
}
exports.createAudioStatus = createAudioStatus

/** Status target JID */
exports.STATUS_BROADCAST_JID = 'status@broadcast'

/** Helper to return the broadcast JID */
const getStatusJid = () => exports.STATUS_BROADCAST_JID
exports.getStatusJid = getStatusJid

/**
 * High-level builder to create and send status messages
 */
exports.StatusHelper = {
    text: (text, backgroundColor, font) => (0, exports.createTextStatus)({ text, backgroundColor, font }),
    image: (buffer, caption) => (0, exports.createImageStatus)(buffer, { caption }),
    imageUrl: (url, caption) => (0, exports.createImageStatus)(url, { caption }),
    video: (buffer, caption) => (0, exports.createVideoStatus)(buffer, { caption }),
    videoUrl: (url, caption) => (0, exports.createVideoStatus)(url, { caption }),
    gif: (buffer, caption) => (0, exports.createVideoStatus)(buffer, { caption, gifPlayback: true }),
    voiceNote: (buffer) => (0, exports.createAudioStatus)(buffer),

    /**
     * Helper to send status to all contacts, specific groups, or individuals.
     * @param {import('../Socket').Socket} sock 
     * @param {AnyMessageContent} content 
     * @param {string[]} jidList List of JIDs (individuals or groups) who should see this status
     */
    send: async (sock, content, jidList = []) => {
        if (!jidList || jidList.length === 0) {
            console.warn('StatusHelper: jidList is empty. Status will potentially be visible to all contacts.')
        }

        const groups = jidList.filter(jid => jid && jid.endsWith('@g.us'))
        const individuals = jidList.filter(jid => jid && (jid.endsWith('@s.whatsapp.net') || jid.endsWith('@lid')))

        let lastResult

        // Handle Group Status
        // Note: In WhatsApp, a group status is a message sent to the group JID with isGroupStatus: true.
        // It appears as a message in the chat but also as a status update for members.
        if (groups.length > 0) {
            const groupContent = {
                ...content,
                groupStatus: true
            }

            for (const groupJid of groups) {
                lastResult = await sock.sendMessage(groupJid, groupContent, {
                    messageId: (0, exports.generateStatusMessageId)()
                })
            }
        }

        // Handle Personal status@broadcast
        // Send to broadcast only if individuals are specified or if targeting all contacts (empty jidList)
        if (individuals.length > 0 || jidList.length === 0) {
            const result = await sock.sendMessage(exports.STATUS_BROADCAST_JID, content, {
                statusJidList: individuals.length > 0 ? individuals : undefined,
                messageId: (0, exports.generateStatusMessageId)()
            })
            if (!lastResult) lastResult = result
        }

        return lastResult
    }
}