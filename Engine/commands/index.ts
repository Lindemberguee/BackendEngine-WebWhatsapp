import { Command } from './types'
import ajuda from './ajuda'
import botoes from './botoes'
import lista from './lista'
import imagem from './imagem'
import audio from './audio'
import video from './video'
import enquete from './enquete'
import reacao from './reacao'
import contato from './contato'
import local from './local'
import agendar from './agendar'
import status from './status'
import url from './url'
import copiar from './copiar'
import misto from './misto'
import editar from './editar'
import deletar from './deletar'
import galeria from './galeria'
import pix from './pix'
import convite from './convite'
import perfil from './perfil'
import ping from './ping'
import mencionar from './mencionar'
import fake from './fake'
import baixar from './baixar'
import painel from './painel'
import endereco from './endereco'
import checkout from './checkout'

export const commands: Command[] = [
    ajuda,
    botoes,
    lista,
    imagem,
    audio,
    video,
    enquete,
    reacao,
    contato,
    local,
    agendar,
    status,
    url,
    copiar,
    misto,
    editar,
    deletar,
    galeria,
    pix,
    convite,
    perfil,
    ping,
    mencionar,
    fake,
    baixar,
    painel,
    endereco,
    checkout
]

export * from './types'
