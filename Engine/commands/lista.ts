import { Command } from './types'
import { generateInteractiveListMessage } from '../lib'

const lista: Command = {
    name: '!lista',
    description: 'Envia um menu de lista interativo',
    category: 'interativo',
    execute: async (sock, jid) => {
        const msg = generateInteractiveListMessage({
            title: '',
            description: 'Selecione uma opção abaixo:',
            buttonText: 'Abrir Menu de Opções',
            footer: 'Baileys-main',
            sections: [
                {
                    title: 'Produtos Disponíveis',
                    rows: [
                        { rowId: 'id1', title: '📦 Produto A', description: 'Descrição detalhada do A' },
                        { rowId: 'id2', title: '📦 Produto B', description: 'Descrição detalhada do B' }
                    ]
                },
                {
                    title: 'Suporte',
                    rows: [
                        { rowId: 'id3', title: '📞 Falar com Atendente' }
                    ]
                }
            ]
        })
        await sock.sendMessage(jid, msg as any)
    }
}

export default lista
