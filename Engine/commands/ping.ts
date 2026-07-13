import { Command } from './types'

const ping: Command = {
    name: '!ping',
    description: 'Calcula a latência do bot',
    category: 'utilitario',
    execute: async (sock, jid) => {
        const start = Date.now()
        const sent = await sock.sendMessage(jid, { text: '🏓 Calculando...' })
        const end = Date.now()
        await sock.sendMessage(jid, { text: `🚀 *PONG!*\nLatência: *${end - start}ms*`, edit: sent?.key })
    }
}

export default ping
