import { Command } from './types'
import { generateUrlButtonMessage } from '../lib'

const url: Command = {
    name: '!url',
    description: 'Envia um botão com link',
    category: 'interativo',
    execute: async (sock, jid) => {
        const urlBtn = generateUrlButtonMessage(
            'Visite nosso site:',
            [{ displayText: 'Abrir Site', url: 'https://google.com' }],
            { title: 'Link Externo' }
        )
        await sock.sendMessage(jid, { ...urlBtn, viewOnce: true } as any)
    }
}

export default url
