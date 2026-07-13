import { Command } from './types'

const contato: Command = {
    name: '!contato',
    description: 'Envia um cartão de contato',
    category: 'utilitario',
    execute: async (sock, jid) => {
        const vcard = 'BEGIN:VCARD\n' +
                    'VERSION:3.0\n' +
                    'FN:Suporte ZapQR\n' +
                    'ORG:Innovators Soft;\n' +
                    'TEL;type=CELL;type=VOICE;waid=5511999999999:+55 11 99999-9999\n' +
                    'END:VCARD'
        await sock.sendMessage(jid, {
            contacts: {
                displayName: 'Suporte ZapQR',
                contacts: [{ vcard }]
            }
        })
    }
}

export default contato
