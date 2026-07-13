import { Command } from './types'
import { generateQuickReplyButtons } from '../lib'

const botoes: Command = {
    name: '!botoes',
    description: 'Envia botões de resposta rápida',
    category: 'interativo',
    execute: async (sock, jid) => {
        const btns = generateQuickReplyButtons(
            'Escolha uma opção:',
            [{ id: '1', displayText: 'Sim' }, { id: '2', displayText: 'Não' }],
            { footer: 'Baileys-main' }
        )
        await sock.sendMessage(jid, { ...btns, viewOnce: true } as any)
    }
}

export default botoes
