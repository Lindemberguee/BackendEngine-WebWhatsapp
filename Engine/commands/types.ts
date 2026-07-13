import { WASocket, WAMessage } from '../lib'

export interface Command {
    name: string;
    description: string;
    category: 'interativo' | 'media' | 'acao' | 'utilitario' | 'ajuda';
    execute: (sock: WASocket, jid: string, m: WAMessage, text: string) => Promise<void>;
}
