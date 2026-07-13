import { Command } from './types'

const audio: Command = {
    name: '!audio',
    description: 'Envia um áudio de teste',
    category: 'media',
    execute: async (sock, jid) => {
        await sock.sendMessage(jid, { 
            audio: { url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' }, 
            mimetype: 'audio/mp4',
            ptt: true 
        })
    }
}

export default audio
