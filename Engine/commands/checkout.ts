import { Command } from './types'

const checkout: Command = {
    name: '!checkout',
    description: 'Resumo de pedido via Carrossel (Universal)',
    category: 'interativo',
    execute: async (sock, jid) => {
        await sock.sendMessage(jid, {
            interactiveMessage: {
                body: { text: '🛍️ *SEU CARRINHO DE COMPRAS*\n\nDeslize para ver os itens e finalize o pedido:' },
                footer: { text: 'Checkout Universal ZapQR' },
                carouselMessage: {
                    cards: [
                        {
                            header: { title: 'Licença Baileys-main', hasMediaAttachment: false },
                            body: { text: 'Quantidade: 1\nPreço: *R$ 150,00*' },
                            nativeFlowMessage: {
                                buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"❌ Remover","id":"rm1"}' }]
                            }
                        },
                        {
                            header: { title: 'TOTAL DO PEDIDO', hasMediaAttachment: false },
                            body: { text: 'Valor Final: *R$ 150,00*\n\nClique abaixo para pagar:' },
                            nativeFlowMessage: {
                                buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"💳 PAGAR AGORA","id":"pay"}' }]
                            }
                        }
                    ]
                }
            }
        } as any)
    }
}

export default checkout
