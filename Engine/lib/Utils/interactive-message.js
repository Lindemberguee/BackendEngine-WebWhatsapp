"use strict"

Object.defineProperty(exports, "__esModule", { value: true })
exports.generateCombinedButtons = exports.generateQuickReplyButtons = exports.generateUrlButtonMessage = exports.generateCopyCodeButton = exports.generateNativeFlowMessage = exports.generateTemplateMessage = exports.generateInteractiveListMessage = exports.generateInteractiveButtonMessage = void 0

const WAProto_1 = require("../../WAProto")
const messages_1 = require("./messages")

const generateInteractiveButtonMessage = async (content, options) => {
    const buttons = content.buttons.map((btn, idx) => ({
        buttonId: btn.buttonId || `btn-${idx}`,
        buttonText: { displayText: btn.displayText },
        type: WAProto_1.proto.Message.ButtonsMessage.Button.Type.RESPONSE,
        nativeFlowInfo: undefined
    }))

    const buttonsMessage = {
        contentText: content.body,
        footerText: content.footer,
        buttons,
        headerType: WAProto_1.proto.Message.ButtonsMessage.HeaderType.EMPTY
    }

    if (content.headerImage && options) {
        const media = await (0, messages_1.prepareWAMessageMedia)({ image: content.headerImage }, options)
        buttonsMessage.imageMessage = media.imageMessage
        buttonsMessage.headerType = WAProto_1.proto.Message.ButtonsMessage.HeaderType.IMAGE
    } else if (content.headerVideo && options) {
        const media = await (0, messages_1.prepareWAMessageMedia)({ video: content.headerVideo }, options)
        buttonsMessage.videoMessage = media.videoMessage
        buttonsMessage.headerType = WAProto_1.proto.Message.ButtonsMessage.HeaderType.VIDEO
    } else if (content.headerDocument && options) {
        const media = await (0, messages_1.prepareWAMessageMedia)({
            document: content.headerDocument,
            mimetype: 'application/pdf',
            fileName: content.headerDocument.filename
        }, options)
        buttonsMessage.documentMessage = media.documentMessage
        buttonsMessage.headerType = WAProto_1.proto.Message.ButtonsMessage.HeaderType.DOCUMENT
    } else if (content.title) {
        buttonsMessage.text = content.title
        buttonsMessage.headerType = WAProto_1.proto.Message.ButtonsMessage.HeaderType.TEXT
    }

    return { buttonsMessage }
}
exports.generateInteractiveButtonMessage = generateInteractiveButtonMessage

const generateInteractiveListMessage = (content) => {
    const sections = content.sections.map(section => ({
        title: section.title,
        rows: section.rows.map(row => ({
            rowId: row.rowId,
            title: row.title,
            description: row.description || ''
        }))
    }))

    return {
        listMessage: {
            title: content.title,
            description: content.description || '',
            buttonText: content.buttonText,
            footerText: content.footer || '',
            listType: WAProto_1.proto.Message.ListMessage.ListType.SINGLE_SELECT,
            sections
        }
    }
}
exports.generateInteractiveListMessage = generateInteractiveListMessage

const generateTemplateMessage = async (content, options) => {
    const hydratedButtons = content.buttons.map((btn) => {
        const hydratedBtn = {
            index: btn.index
        }

        if (btn.quickReplyButton) {
            hydratedBtn.quickReplyButton = {
                displayText: btn.quickReplyButton.displayText,
                id: btn.quickReplyButton.id
            }
        } else if (btn.urlButton) {
            hydratedBtn.urlButton = {
                displayText: btn.urlButton.displayText,
                url: btn.urlButton.url
            }
        } else if (btn.callButton) {
            hydratedBtn.callButton = {
                displayText: btn.callButton.displayText,
                phoneNumber: btn.callButton.phoneNumber
            }
        }

        return hydratedBtn
    })

    const hydratedTemplate = {
        hydratedContentText: content.body,
        hydratedFooterText: content.footer,
        hydratedButtons
    }

    if (content.title) {
        hydratedTemplate.hydratedTitleText = content.title
    }

    if (content.headerImage && options) {
        const media = await (0, messages_1.prepareWAMessageMedia)({ image: content.headerImage }, options)
        hydratedTemplate.imageMessage = media.imageMessage
    } else if (content.headerVideo && options) {
        const media = await (0, messages_1.prepareWAMessageMedia)({ video: content.headerVideo }, options)
        hydratedTemplate.videoMessage = media.videoMessage
    } else if (content.headerLocation) {
        hydratedTemplate.locationMessage = {
            degreesLatitude: content.headerLocation.latitude,
            degreesLongitude: content.headerLocation.longitude,
            name: content.headerLocation.name,
            address: content.headerLocation.address
        }
    }

    return {
        templateMessage: {
            hydratedTemplate
        }
    }
}
exports.generateTemplateMessage = generateTemplateMessage

const generateNativeFlowMessage = (body, buttons, options) => {
    const nativeFlowButtons = buttons.map((btn, idx) => ({
        name: btn.name,
        buttonParamsJson: btn.buttonParamsJson
    }))

    return {
        interactiveMessage: {
            body: { text: body },
            footer: options?.footer ? { text: options.footer } : undefined,
            header: options?.header ? {
                title: options.header.title,
                subtitle: options.header.subtitle,
                hasMediaAttachment: options.header.hasMediaAttachment || false
            } : undefined,
            nativeFlowMessage: {
                buttons: nativeFlowButtons,
                messageParamsJson: ''
            }
        }
    }
}
exports.generateNativeFlowMessage = generateNativeFlowMessage

const generateCopyCodeButton = (body, copyCode, displayText = 'Copy Code', options) => {
    return (0, exports.generateNativeFlowMessage)(
        body,
        [{
            name: 'cta_copy',
            buttonParamsJson: JSON.stringify({
                display_text: displayText,
                copy_code: copyCode
            })
        }],
        options
    )
}
exports.generateCopyCodeButton = generateCopyCodeButton

const generateUrlButtonMessage = (body, buttons, options) => {
    const nativeButtons = buttons.map(btn => ({
        name: 'cta_url',
        buttonParamsJson: JSON.stringify({
            display_text: btn.displayText,
            url: btn.url,
            merchant_url: btn.merchantUrl
        })
    }))

    return (0, exports.generateNativeFlowMessage)(body, nativeButtons, {
        footer: options?.footer,
        header: options?.title ? { title: options.title } : undefined
    })
}
exports.generateUrlButtonMessage = generateUrlButtonMessage

const generateQuickReplyButtons = (body, buttons, options) => {
    const nativeButtons = buttons.map(btn => ({
        name: 'quick_reply',
        buttonParamsJson: JSON.stringify({
            display_text: btn.displayText,
            id: btn.id
        })
    }))

    return (0, exports.generateNativeFlowMessage)(body, nativeButtons, {
        footer: options?.footer,
        header: options?.title ? { title: options.title } : undefined
    })
}
exports.generateQuickReplyButtons = generateQuickReplyButtons

const generateCombinedButtons = (body, buttons, options) => {
    const nativeButtons = buttons.map(btn => {
        switch (btn.type) {
            case 'url':
                return {
                    name: 'cta_url',
                    buttonParamsJson: JSON.stringify({
                        display_text: btn.displayText,
                        url: btn.url
                    })
                }
            case 'reply':
                return {
                    name: 'quick_reply',
                    buttonParamsJson: JSON.stringify({
                        display_text: btn.displayText,
                        id: btn.id
                    })
                }
            case 'copy':
                return {
                    name: 'cta_copy',
                    buttonParamsJson: JSON.stringify({
                        display_text: btn.displayText,
                        copy_code: btn.copyCode
                    })
                }
            case 'call':
                return {
                    name: 'cta_call',
                    buttonParamsJson: JSON.stringify({
                        display_text: btn.displayText,
                        phone_number: btn.phoneNumber
                    })
                }
        }
    })

    return (0, exports.generateNativeFlowMessage)(body, nativeButtons, {
        footer: options?.footer,
        header: options?.title ? { title: options.title } : undefined
    })
}
exports.generateCombinedButtons = generateCombinedButtons
