import { Command } from './types'

const enquete: Command = {
    name: '!enquete',
    description: 'Cria uma enquete de teste',
    category: 'acao',
    execute: async (sock, jid) => {
        await sock.sendMessage(jid, {
            poll: {
                name: 'Você gosta desta biblioteca?',
                values: ['Sim', 'Muito', 'Com certeza'],
                selectableCount: 1
            }
        })
    }
}

export default enquete
