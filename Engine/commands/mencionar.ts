import { Command } from './types'

const mencionar: Command = {
    name: '!mencionar',
    description: 'Marca o usuário em uma mensagem',
    category: 'utilitario',
    execute: async (sock, jid) => {
        await sock.sendMessage(jid, {
            text: `Olá @${jid.split('@')[0]}, eu vi você! 👋`,
            mentions: [jid]
        })
    }
}

export default mencionar
