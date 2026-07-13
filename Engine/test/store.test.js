const { makeInMemoryStore } = require('../lib/Store')
const EventEmitter = require('events')

describe('In-Memory Store Implementation', () => {
    let store
    let ev

    beforeEach(() => {
        ev = new EventEmitter()
        store = makeInMemoryStore({ logger: { debug: jest.fn(), error: jest.fn(), trace: jest.fn(), info: jest.fn() } })
        store.bind(ev)
    })

    test('should store LID-PN mappings', () => {
        const lid = '12345@lid'
        const pn = '67890@s.whatsapp.net'

        ev.emit('lid-mapping.update', { lid, pn })

        const json = store.toJSON()
        expect(json.lidMappings[lid]).toBe(pn)
        expect(json.lidMappings[pn]).toBe(lid)
    })

    test('should handle group participant updates with new admin field', () => {
        const groupId = 'group@g.us'

        // Initial group metadata
        ev.emit('groups.upsert', [{
            id: groupId,
            subject: 'Test Group',
            participants: []
        }])

        // Add participants
        ev.emit('group-participants.update', {
            id: groupId,
            participants: [
                { id: 'user1@s.whatsapp.net', admin: 'admin' },
                { id: 'user2@s.whatsapp.net', admin: null }
            ],
            action: 'add'
        })

        expect(store.groupMetadata[groupId].participants).toHaveLength(2)
        expect(store.groupMetadata[groupId].participants.find(p => p.id === 'user1@s.whatsapp.net').admin).toBe('admin')
        expect(store.groupMetadata[groupId].participants.find(p => p.id === 'user2@s.whatsapp.net').admin).toBeNull()

        // Promote user2
        ev.emit('group-participants.update', {
            id: groupId,
            participants: ['user2@s.whatsapp.net'],
            action: 'promote'
        })

        expect(store.groupMetadata[groupId].participants.find(p => p.id === 'user2@s.whatsapp.net').admin).toBe('admin')

        // Demote user1
        ev.emit('group-participants.update', {
            id: groupId,
            participants: ['user1@s.whatsapp.net'],
            action: 'demote'
        })

        expect(store.groupMetadata[groupId].participants.find(p => p.id === 'user1@s.whatsapp.net').admin).toBeNull()
    })
})
