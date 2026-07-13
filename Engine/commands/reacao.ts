import { Command } from './types'

const reacao: Command = {
    name: '!reacao',
    description: 'Reage a uma mensagem',
    category: 'acao',
    execute: async (sock, jid, m) => {
        await sock.sendMessage(jid, { react: { text: '🚀', key: m.key } })
    }
}

export default reacao
