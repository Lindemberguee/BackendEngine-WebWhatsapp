import makeWASocket, { 
    DisconnectReason, 
    useMultiFileAuthState 
} from './lib'
import { Boom } from '@hapi/boom'
import pino from 'pino'
import { commands } from './commands'

/**
 * CONFIGURAÇÃO DE LOGS
 */
const logger = pino(
    { level: 'debug' }, 
    pino.destination('./baileys-log.json')
)

async function startBot() {
    console.log('🚀 Iniciando Baileys-main (Modo Modular)...')

    const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys')

    const sock = makeWASocket({
        printQRInTerminal: true,
        auth: state,
        logger,
        defaultQueryTimeoutMs: 60000
    })

    // --- GESTÃO DE CONEXÃO ---
    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update
        
        if (connection === 'open') {
            console.log('\n✅ BOT MODULAR CONECTADO COM SUCESSO!')
            console.log(`📦 ${commands.length} comandos carregados dinamicamente.\n`)
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode
            if (statusCode !== DisconnectReason.loggedOut) {
                console.log(`⚠️ Conexão perdida. Tentando reconectar...`)
                setTimeout(() => startBot(), 3000)
            }
        }
    })

    sock.ev.on('creds.update', saveCreds)

    // --- PROCESSAMENTO DE MENSAGENS (HANDLER MODULAR) ---
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return

        for (const m of messages) {
            if (!m.message || m.key.fromMe) continue

            const jid = m.key.remoteJidAlt || m.key.remoteJid!
            const text = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim().toLowerCase()

            if (!text.startsWith('!')) continue 

            // Busca o comando correspondente na nossa lista modular
            const command = commands.find(c => c.name === text)
            
            if (command) {
                console.log(`[Comando] Executando ${command.name} para ${jid}`)
                try {
                    await command.execute(sock, jid, m, text)
                } catch (err: any) {
                    console.error(`❌ Erro ao executar ${command.name}:`, err.message)
                    await sock.sendMessage(jid, { text: `Desculpe, ocorreu um erro ao executar este comando.` })
                }
            } else {
                console.log(`[Aviso] Comando desconhecido: ${text}`)
                await sock.sendMessage(jid, { text: 'Comando não reconhecido. Digite *!ajuda* para ver a lista.' })
            }
        }
    })
}

// Iniciar
startBot().catch(err => console.error('💥 Falha fatal:', err))
