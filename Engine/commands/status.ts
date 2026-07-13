import { Command } from './types'
import { delay } from '../lib'

const status: Command = {
    name: '!status',
    description: 'Mostra o bot digitando por 3 segundos',
    category: 'utilitario',
    execute: async (sock, jid) => {
        await sock.sendPresenceUpdate('composing', jid)
        await delay(3000)
        await sock.sendMessage(jid, { text: 'Terminei de digitar! ⌨️' })
    }
}

export default status
