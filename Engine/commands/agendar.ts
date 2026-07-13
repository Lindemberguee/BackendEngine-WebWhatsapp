import { Command } from './types'

const agendar: Command = {
    name: '!agendar',
    description: 'Envia uma mensagem agendada para 10s',
    category: 'utilitario',
    execute: async (sock, jid) => {
        await sock.sendMessage(jid, { text: '⏳ Ok! Mensagem agendada para daqui a 10 segundos...' })
        setTimeout(async () => {
            await sock.sendMessage(jid, { text: '✅ OI! Sou a mensagem agendada. Funciona perfeitamente! 🚀' })
        }, 10000)
    }
}

export default agendar
