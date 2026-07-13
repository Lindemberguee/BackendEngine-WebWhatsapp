import { proto } from '../../WAProto'
import { Chat, Contact, LIDMapping } from '../Types'
import { ILogger } from './logger'

export declare const downloadHistory: (msg: proto.Message.IHistorySyncNotification, options: RequestInit) => Promise<proto.HistorySync>

export declare const processHistoryMessage: (item: proto.IHistorySync, logger?: ILogger) => {
    chats: Chat[]
    contacts: Contact[]
    messages: proto.IWebMessageInfo[]
    lidPnMappings: LIDMapping[]
    syncType: proto.HistorySync.HistorySyncType
    progress: number | null | undefined
}

export declare const downloadAndProcessHistorySyncNotification: (msg: proto.Message.IHistorySyncNotification, options: RequestInit, logger?: ILogger) => Promise<{
    chats: Chat[]
    contacts: Contact[]
    messages: proto.IWebMessageInfo[]
    lidPnMappings: LIDMapping[]
    syncType: proto.HistorySync.HistorySyncType
    progress: number | null | undefined
}>

export declare const getHistoryMsg: (message: proto.IMessage) => proto.Message.IHistorySyncNotification | null | undefined