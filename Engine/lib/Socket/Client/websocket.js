"use strict"

var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod }
}

Object.defineProperty(exports, "__esModule", { value: true })

const ws_1 = __importDefault(require("ws"))
const Defaults_1 = require("../../Defaults")
const types_1 = require("./types")

class WebSocketClient extends types_1.AbstractSocketClient {
    constructor() {
        super(...arguments)
        this.socket = null
        /**
         * CONNECTION STABILITY: Store references to the event forwarding
         * functions so they can be removed from the native WebSocket when
         * the connection closes. Without this, the native socket holds
         * references to this.emit which prevents GC of the client.
         */
        this.socketListeners = new Map()
    }
    get isOpen() {
        return this.socket?.readyState === ws_1.default.OPEN
    }
    get isClosed() {
        return this.socket?.readyState === ws_1.default.CLOSED
    }
    get isClosing() {
        this.socket?.readyState === ws_1.default.CLOSING
    }
    get isConnecting() {
        this.socket?.readyState === ws_1.default.CONNECTING
    }
    async connect() {
        if (this.socket) {
            return
        }
        this.socket = new ws_1.default(this.url, {
            origin: Defaults_1.DEFAULT_ORIGIN,
            headers: this.config.options?.headers,
            handshakeTimeout: this.config.connectTimeoutMs,
            timeout: this.config.connectTimeoutMs,
            agent: this.config.agent,
        })
        this.socket.setMaxListeners(0)
        const events = ['close', 'error', 'upgrade', 'message', 'open', 'ping', 'pong', 'unexpected-response']
        for (const event of events) {
            const handler = (...args) => this.emit(event, ...args)
            this.socketListeners.set(event, handler)
            this.socket?.on(event, handler)
        }
    }
    async close() {
        if (!this.socket) {
            return
        }
        /**
         * CONNECTION STABILITY: Remove all forwarding listeners from the
         * native WebSocket before closing to break the reference chain.
         */
        for (const [event, handler] of this.socketListeners) {
            this.socket.removeListener(event, handler)
        }
        this.socketListeners.clear()

        this.socket.close()
        this.socket = null
    }
    send(str, cb) {
        this.socket?.send(str, cb)
        return Boolean(this.socket)
    }
}

module.exports = {
  WebSocketClient
}