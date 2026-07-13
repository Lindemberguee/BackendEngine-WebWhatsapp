import { Command } from './types'

const editar: Command = {
    name: '!editar',
    description: 'Envia e edita uma mensagem',
    category: 'acao',
    execute: async (sock, jid) => {
        const sent = await sock.sendMessage(jid, { text: 'Mensagem original...' })
        await new Promise(resolve => setTimeout(resolve, 2000))
        await sock.sendMessage(jid, { text: '✅ Mensagem EDITADA com sucesso!', edit: sent?.key })
    }
}

export default editar
