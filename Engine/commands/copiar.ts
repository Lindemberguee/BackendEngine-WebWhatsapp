import { Command } from './types'
import { generateCopyCodeButton } from '../lib'

const copiar: Command = {
    name: '!copiar',
    description: 'Envia um botão de copiar código',
    category: 'interativo',
    execute: async (sock, jid) => {
        const copyBtn = generateCopyCodeButton('Seu código de desconto:', 'CUPOM-TOP-2024', '📋 Copiar Código')
        await sock.sendMessage(jid, { ...copyBtn, viewOnce: true } as any)
    }
}

export default copiar
