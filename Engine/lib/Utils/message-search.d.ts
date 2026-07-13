import type { WAMessage } from '../Types'

export interface SearchOptions {
    caseSensitive?: boolean
    jid?: string
    fromDate?: Date
    toDate?: Date
    limit?: number
    messageTypes?: ('text' | 'image' | 'video' | 'document' | 'audio' | 'sticker' | 'location' | 'contact')[]
    includeCaption?: boolean
    fromSender?: string
    fromMe?: boolean
}

export interface SearchResult {
    message: WAMessage
    matchedText: string
    matchPosition: number
    relevanceScore: number
}

export declare const extractMessageText: (message: WAMessage) => string

export declare const searchMessages: (
    messages: WAMessage[],
    query: string,
    options?: SearchOptions
) => SearchResult[]

export declare const searchMessagesRegex: (
    messages: WAMessage[],
    pattern: RegExp,
    options?: Omit<SearchOptions, 'caseSensitive'>
) => SearchResult[]

export declare class MessageSearchManager {
    private messages
    private messageIndex
    constructor()
    addMessages(messages: WAMessage[]): void
    removeMessages(messageIds: string[]): void
    clear(): void
    get count(): number
    search(query: string, options?: SearchOptions): SearchResult[]
    searchRegex(pattern: RegExp, options?: Omit<SearchOptions, 'caseSensitive'>): SearchResult[]
    getByJid(jid: string): WAMessage[]
    getBySender(sender: string): WAMessage[]
    getByType(type: 'text' | 'image' | 'video' | 'document' | 'audio' | 'sticker' | 'location' | 'contact'): WAMessage[]
    getById(id: string): WAMessage | undefined
}

export declare const createMessageSearch: () => MessageSearchManager
