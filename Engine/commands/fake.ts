import { Command } from './types'

const fake: Command = {
    name: '!fake',
    description: 'Responde a uma mensagem simulada',
    category: 'acao',
    execute: async (sock, jid) => {
        await sock.sendMessage(jid, {
            text: 'Eu também acho! 🤝'
        }, {
            quoted: {
                key: { remoteJid: jid, fromMe: false, id: 'FAKE-ID' },
                message: { conversation: 'O Baileys-main é o melhor!' }
            }
        })
    }
}

export default fake
