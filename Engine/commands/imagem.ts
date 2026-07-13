import { Command } from './types'
import fs from 'fs'

const imagem: Command = {
    name: '!imagem',
    description: 'Envia uma imagem de teste',
    category: 'media',
    execute: async (sock, jid) => {
        const path = './assets/media/logo.png'
        const imgSource = fs.existsSync(path) ? fs.readFileSync(path) : { url: 'https://raw.githubusercontent.com/innovatorssoft/Baileys/main/assets/media/logo.png' }
        await sock.sendMessage(jid, { 
            image: imgSource as any, 
            caption: '🖼️ Teste de Imagem' 
        })
    }
}

export default imagem
