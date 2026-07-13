import { Command } from './types'
import { downloadMediaMessage } from '../lib'
import fs from 'fs'

const baixar: Command = {
    name: '!baixar',
    description: 'Baixa a mídia da mensagem respondida',
    category: 'media',
    execute: async (sock, jid, m) => {
        const quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage
        if (!quoted) {
            await sock.sendMessage(jid, { text: '❌ Você precisa responder a uma imagem ou vídeo com este comando!' })
            return
        }

        const mime = Object.keys(quoted)[0]
        if (!['imageMessage', 'videoMessage', 'audioMessage'].includes(mime)) {
            await sock.sendMessage(jid, { text: '❌ A mensagem respondida não contém uma mídia válida.' })
            return
        }

        await sock.sendMessage(jid, { text: '⏳ Baixando mídia... por favor aguarde.' })

        try {
            const buffer = await downloadMediaMessage(
                { message: quoted } as any,
                'buffer',
                {},
                { logger: sock.logger as any, reuploadRequest: sock.updateMediaMessage }
            )

            const type = mime.replace('Message', '')
            await sock.sendMessage(jid, { [type]: buffer, caption: '✅ Aqui está sua mídia baixada!' } as any)
        } catch (err: any) {
            await sock.sendMessage(jid, { text: `💥 Erro ao baixar mídia: ${err.message}` })
        }
    }
}

export default baixar
