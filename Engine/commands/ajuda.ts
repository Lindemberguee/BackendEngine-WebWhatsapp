import { Command } from './types'

const ajuda: Command = {
    name: '!ajuda',
    description: 'Exibe o menu de comandos',
    category: 'ajuda',
    execute: async (sock, jid) => {
        const menu = `*🤖 LABORATÓRIO BAILEYS-MAIN*\n\n` +
                   `*Interativos:* !botoes, !lista, !misto, !url, !copiar, !galeria, !pix, !painel, !endereco, !checkout\n` +
                   `*Mídia:* !imagem, !audio, !video, !documento, !baixar\n` +
                   `*Ações:* !reacao, !editar, !deletar, !enquete, !fake\n` +
                   `*Utilitários:* !contato, !local, !agendar, !convite, !perfil, !ping, !mencionar`
        await sock.sendMessage(jid, { text: menu })
    }
}

export default ajuda
