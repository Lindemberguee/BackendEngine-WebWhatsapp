import { Command } from './types'
import { generateCopyCodeButton } from '../lib'

const pagamento: Command = {
    name: '!pagamento',
    description: 'Envia cobrança via PIX Copia e Cola',
    category: 'interativo',
    execute: async (sock, jid) => {
        // Simulando um código PIX real
        const pixCode = '00020101021126580014br.gov.bcb.pix0114suporte@zapqr.com.br520400005303986540550.005802BR5915Innovators Soft6009Sao Paulo62070503***6304ABCD'
        
        const pixBtn = generateCopyCodeButton(
            '💠 *CHECKOUT PIX*\n\n' +
            'Valor: *R$ 50,00*\n' +
            'Beneficiário: *ZapQR Softwares*\n\n' +
            'Clique no botão abaixo para copiar o código PIX Copia e Cola:',
            pixCode,
            '📋 Copiar Código PIX'
        )

        await sock.sendMessage(jid, { 
            ...pixBtn,
            footer: 'Pague em qualquer aplicativo de banco.',
            viewOnce: true 
        } as any)
    }
}

export default pagamento
