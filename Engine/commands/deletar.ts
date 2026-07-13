import { Command } from './types'

const deletar: Command = {
    name: '!deletar',
    description: 'Envia e deleta uma mensagem',
    category: 'acao',
    execute: async (sock, jid) => {
        const sent = await sock.sendMessage(jid, { text: 'Esta mensagem será deletada em 2s...' })
        await new Promise(resolve => setTimeout(resolve, 2000))
        await sock.sendMessage(jid, { delete: sent?.key })
    }
}

export default deletar
