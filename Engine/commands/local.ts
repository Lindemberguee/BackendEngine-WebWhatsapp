import { Command } from './types'

const local: Command = {
    name: '!local',
    description: 'Envia uma localização',
    category: 'utilitario',
    execute: async (sock, jid) => {
        await sock.sendMessage(jid, {
            location: { degreesLatitude: -23.5505, degreesLongitude: -46.6333, name: 'São Paulo, Brasil' }
        })
    }
}

export default local
