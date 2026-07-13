import { Command } from './types'

const endereco: Command = {
    name: '!endereco',
    description: 'Coleta de endereço via Carrossel (Universal)',
    category: 'interativo',
    execute: async (sock, jid) => {
        await sock.sendMessage(jid, {
            interactiveMessage: {
                body: { text: '📍 *ESCOLHA O MÉTODO DE ENTREGA*\n\nSelecione como deseja receber seu pedido:' },
                footer: { text: 'Logística ZapQR' },
                carouselMessage: {
                    cards: [
                        {
                            header: { title: 'Entrega Expressa', hasMediaAttachment: false },
                            body: { text: 'Receba em até 30 minutos no seu endereço atual.' },
                            nativeFlowMessage: {
                                buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"📍 Usar GPS","id":"gps"}' }]
                            }
                        },
                        {
                            header: { title: 'Retirada em Loja', hasMediaAttachment: false },
                            body: { text: 'Retire sem custos em nossa unidade central.' },
                            nativeFlowMessage: {
                                buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"🏬 Ver Unidades","id":"units"}' }]
                            }
                        }
                    ]
                }
            }
        } as any)
    }
}

export default endereco
