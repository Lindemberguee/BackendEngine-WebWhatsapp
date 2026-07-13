import { Command } from './types'
import { generateCombinedButtons } from '../lib'

const misto: Command = {
    name: '!misto',
    description: 'Envia botões mistos (Reply, URL, Copy)',
    category: 'interativo',
    execute: async (sock, jid) => {
        const mistoBtn = generateCombinedButtons('Ações Mistas:', [
            { type: 'reply', displayText: 'Resposta Rápida', id: '1' },
            { type: 'url', displayText: 'Link Google', url: 'https://google.com' },
            { type: 'copy', displayText: 'Copiar ID', copyCode: 'MY-CODE-123' }
        ])
        await sock.sendMessage(jid, { ...mistoBtn, viewOnce: true } as any)
    }
}

export default misto
