import { Command } from './types'

const video: Command = {
    name: '!video',
    description: 'Envia um vídeo de teste',
    category: 'media',
    execute: async (sock, jid) => {
        await sock.sendMessage(jid, { 
            video: { url: 'https://www.w3schools.com/html/mov_bbb.mp4' }, 
            caption: '📹 Teste de Vídeo' 
        })
    }
}

export default video
