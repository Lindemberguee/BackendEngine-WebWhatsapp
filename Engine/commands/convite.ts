import { Command } from './types'

const convite: Command = {
    name: '!convite',
    description: 'Envia um convite de grupo formatado',
    category: 'utilitario',
    execute: async (sock, jid) => {
        await sock.sendMessage(jid, {
            text: 'Entre no nosso grupo oficial de testes!',
            contextInfo: {
                groupInviteMessage: {
                    groupJid: '123456789@g.us',
                    inviteCode: 'ZapQRInviteCode',
                    groupName: '🚀 Laboratório Baileys-main',
                    caption: 'Convite Especial'
                }
            }
        } as any)
    }
}

export default convite
