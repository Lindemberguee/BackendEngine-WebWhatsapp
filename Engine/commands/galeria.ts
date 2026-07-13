import { Command } from './types'
import { prepareWAMessageMedia } from '../lib'

const galeria: Command = {
    name: '!galeria',
    description: 'Envia um carrossel de cards (Galeria)',
    category: 'interativo',
    execute: async (sock, jid) => {
        await sock.sendMessage(jid, {
            interactiveMessage: {
                body: { text: 'Explore nossa Galeria Premium:' },
                footer: { text: 'Baileys-main Carousel' },
                carouselMessage: {
                    cards: [
                        {
                            header: {
                                title: 'Produto 1',
                                hasMediaAttachment: true,
                                imageMessage: (await prepareWAMessageMedia({ image: { url: 'https://picsum.photos/800/400?1' } }, { upload: sock.waUploadToServer })).imageMessage
                            },
                            body: { text: 'Este é o primeiro item da galeria.' },
                            nativeFlowMessage: {
                                buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"Ver Detalhes","id":"p1"}' }]
                            }
                        },
                        {
                            header: {
                                title: 'Produto 2',
                                hasMediaAttachment: true,
                                imageMessage: (await prepareWAMessageMedia({ image: { url: 'https://picsum.photos/800/400?2' } }, { upload: sock.waUploadToServer })).imageMessage
                            },
                            body: { text: 'Segundo item com descrição personalizada.' },
                            nativeFlowMessage: {
                                buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"Comprar Agora","id":"p2"}' }]
                            }
                        },
                        {
                            header: {
                                title: 'Produto 3',
                                hasMediaAttachment: true,
                                imageMessage: (await prepareWAMessageMedia({ image: { url: 'https://picsum.photos/800/400?3' } }, { upload: sock.waUploadToServer })).imageMessage
                            },
                            body: { text: 'Terceiro item da nossa vitrine.' },
                            nativeFlowMessage: {
                                buttons: [{ name: 'quick_reply', buttonParamsJson: '{"display_text":"Adicionar ao Carrinho","id":"p3"}' }]
                            }
                        }
                    ]
                }
            }
        } as any)
    }
}

export default galeria
