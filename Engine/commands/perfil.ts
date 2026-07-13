import { Command } from './types'

const perfil: Command = {
    name: '!perfil',
    description: 'Altera o recado (Bio) do bot',
    category: 'utilitario',
    execute: async (sock, jid) => {
        const bio = `🤖 Baileys-main Modular | Ativo em ${new Date().toLocaleTimeString()}`
        await sock.updateProfileStatus(bio)
        await sock.sendMessage(jid, { text: `✅ Recado do perfil atualizado para:\n"${bio}"` })
    }
}

export default perfil
