import { Command } from './types'

const painel: Command = {
    name: '!painel',
    description: 'Envia um painel de controle com múltiplas opções',
    category: 'interativo',
    execute: async (sock, jid) => {
        await sock.sendMessage(jid, {
            interactiveMessage: {
                body: { text: '🖥️ *PAINEL DE CONTROLE ZAPQR*\n\nSeja bem-vindo ao centro de comando. Escolha uma das operações abaixo para gerenciar sua instância:' },
                footer: { text: 'Sistema Operacional Baileys-main' },
                nativeFlowMessage: {
                    buttons: [
                        { name: 'quick_reply', buttonParamsJson: '{"display_text":"📊 Ver Estatísticas","id":"stats"}' },
                        { name: 'quick_reply', buttonParamsJson: '{"display_text":"👥 Gerenciar Grupos","id":"groups"}' },
                        { name: 'quick_reply', buttonParamsJson: '{"display_text":"💰 Financeiro","id":"finance"}' },
                        { name: 'quick_reply', buttonParamsJson: '{"display_text":"⚙️ Configurações","id":"settings"}' },
                        { name: 'quick_reply', buttonParamsJson: '{"display_text":"🆘 Suporte Humano","id":"support"}' }
                    ]
                }
            }
        } as any)
    }
}

export default painel
