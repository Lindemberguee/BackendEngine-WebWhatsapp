import { proto } from '../../WAProto/index.js'
import type { WAMediaUpload, WAMessageContent } from '../Types'
import type { MediaGenerationOptions } from '../Types/Message'

export interface InteractiveButton {
    name: string
    buttonId: string
    displayText: string
}

export interface InteractiveButtonReply extends InteractiveButton {
    index?: number
}

export interface QuickReplyButton {
    id: string
    displayText: string
}

export interface UrlButton {
    displayText: string
    url: string
    merchantUrl?: string
}

export interface CallButton {
    displayText: string
    phoneNumber: string
}

export interface CopyButton {
    displayText: string
    copyCode: string
}

export interface ListSection {
    title: string
    rows: ListRow[]
}

export interface ListRow {
    rowId: string
    title: string
    description?: string
}

export interface InteractiveListMessage {
    title: string
    buttonText: string
    sections: ListSection[]
    footer?: string
    description?: string
}

export interface InteractiveButtonsMessage {
    title?: string
    body: string
    footer?: string
    buttons: InteractiveButton[]
    headerImage?: WAMediaUpload
    headerVideo?: WAMediaUpload
    headerDocument?: WAMediaUpload & { filename?: string }
}

export interface TemplateButton {
    index: number
    quickReplyButton?: QuickReplyButton
    urlButton?: UrlButton
    callButton?: CallButton
}

export interface TemplateMessage {
    namespace?: string
    title?: string
    body: string
    footer?: string
    buttons: TemplateButton[]
    headerImage?: WAMediaUpload
    headerVideo?: WAMediaUpload
    headerLocation?: {
        latitude: number
        longitude: number
        name?: string
        address?: string
    }
}

export declare const generateInteractiveButtonMessage: (content: InteractiveButtonsMessage, options?: MediaGenerationOptions) => Promise<WAMessageContent>
export declare const generateInteractiveListMessage: (content: InteractiveListMessage) => WAMessageContent
export declare const generateTemplateMessage: (content: TemplateMessage, options?: MediaGenerationOptions) => Promise<WAMessageContent>
export declare const generateNativeFlowMessage: (body: string, buttons: Array<{
    name: string
    buttonParamsJson: string
}>, options?: {
    footer?: string
    header?: {
        title?: string
        subtitle?: string
        hasMediaAttachment?: boolean
    }
}) => WAMessageContent
export declare const generateCopyCodeButton: (body: string, copyCode: string, displayText?: string, options?: {
    footer?: string
}) => WAMessageContent
export declare const generateUrlButtonMessage: (body: string, buttons: Array<{
    displayText: string
    url: string
    merchantUrl?: string
}>, options?: {
    footer?: string
    title?: string
}) => WAMessageContent
export declare const generateQuickReplyButtons: (body: string, buttons: Array<{
    id: string
    displayText: string
}>, options?: {
    footer?: string
    title?: string
}) => WAMessageContent
export declare const generateCombinedButtons: (body: string, buttons: Array<{
    type: 'url'
    displayText: string
    url: string
} | {
    type: 'reply'
    displayText: string
    id: string
} | {
    type: 'copy'
    displayText: string
    copyCode: string
} | {
    type: 'call'
    displayText: string
    phoneNumber: string
}>, options?: {
    footer?: string
    title?: string
}) => WAMessageContent
