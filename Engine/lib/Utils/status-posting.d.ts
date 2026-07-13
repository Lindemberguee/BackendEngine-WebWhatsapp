import type { AnyMessageContent } from '../Types'

export type StatusType = 'text' | 'image' | 'video' | 'audio'

export interface TextStatusOptions {
    text: string
    backgroundColor?: string
    font?: number
    textColor?: string
}

export interface MediaStatusOptions {
    media: Buffer | string
    caption?: string
    viewOnce?: boolean
}

export interface StatusPostResult {
    messageId: string
    timestamp: Date
    type: StatusType
}

/** Pre-defined background colors for text status */
export declare const STATUS_BACKGROUNDS: {
    solid: {
        green: string
        blue: string
        purple: string
        red: string
        orange: string
        yellow: string
        pink: string
        teal: string
        gray: string
        black: string
        white: string
    }
    gradient: {
        sunset: string[]
        ocean: string[]
        forest: string[]
        purple: string[]
        midnight: string[]
        aurora: string[]
    }
}

/** Font types for text status (0-9) */
export declare const STATUS_FONTS: {
    readonly SANS_SERIF: 0
    readonly SERIF: 1
    readonly NORICAN: 2
    readonly BRYNDAN: 3
    readonly BEBASNEUE: 4
    readonly OSWALD: 5
    readonly DAMION: 6
    readonly DANCING: 7
    readonly COMFORTAA: 8
    readonly EXOTWO: 9
}

export declare const generateStatusMessageId: () => string

export declare const createTextStatus: (options: TextStatusOptions) => AnyMessageContent
export declare const createImageStatus: (media: Buffer | string, options?: { caption?: string; viewOnce?: boolean }) => AnyMessageContent
export declare const createVideoStatus: (media: Buffer | string, options?: { caption?: string; viewOnce?: boolean; gifPlayback?: boolean }) => AnyMessageContent
export declare const createAudioStatus: (media: Buffer | string, options?: { ptt?: boolean }) => AnyMessageContent

export declare const STATUS_BROADCAST_JID = "status@broadcast"
export declare const getStatusJid: () => string

export declare const StatusHelper: {
    text: (text: string, backgroundColor?: string) => AnyMessageContent
    image: (buffer: Buffer, caption?: string) => AnyMessageContent
    imageUrl: (url: string, caption?: string) => AnyMessageContent
    video: (buffer: Buffer, caption?: string) => AnyMessageContent
    videoUrl: (url: string, caption?: string) => AnyMessageContent
    gif: (buffer: Buffer, caption?: string) => AnyMessageContent
    voiceNote: (buffer: Buffer) => AnyMessageContent
}
