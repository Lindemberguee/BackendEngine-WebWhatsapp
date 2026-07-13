const { makeLibSignalRepository } = require('../lib/Signal/libsignal')

describe('LibSignal Repository', () => {
    let repository
    let auth

    beforeEach(() => {
        auth = {
            creds: { me: { id: 'user@s.whatsapp.net' }, registrationId: 123 },
            keys: {
                get: jest.fn().mockResolvedValue({}),
                set: jest.fn().mockResolvedValue(null),
                transaction: jest.fn((cb) => cb())
            }
        }
        repository = makeLibSignalRepository(auth, jest.fn(), { info: jest.fn(), debug: jest.fn(), warn: jest.fn() })
    })

    test('migrateSession should handle single string JID', async () => {
        const fromJid = '12345@s.whatsapp.net'
        const toJid = '67890@lid'

        // Should not throw Error: fromJids.filter is not a function
        await repository.migrateSession(fromJid, toJid)
        expect(auth.keys.transaction).toHaveBeenCalled()
    })

    test('deleteSession should handle single string JID', async () => {
        const jid = '12345@s.whatsapp.net'

        // Should not throw Error: jids.forEach is not a function
        await repository.deleteSession(jid)
        expect(auth.keys.transaction).toHaveBeenCalled()
    })
})
