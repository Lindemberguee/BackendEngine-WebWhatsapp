import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { registerWorkspace, loginUser } from './auth.service';

// Integration test against a real (in-memory) MongoDB — the highest-value path in the
// whole system: without registration + login working, nothing else is reachable.
let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('registerWorkspace + loginUser', () => {
  it('registers a workspace and owner, then logs the owner in with the right password', async () => {
    const { user, workspaceId } = await registerWorkspace({
      workspaceName: 'Acme Corp',
      ownerName: 'Alice',
      email: 'alice@acme.test',
      password: 'super-secret-123',
      acceptedTerms: true,
    });

    expect(user.role).toBe('owner');
    expect(user.workspaceId.toString()).toBe(workspaceId);

    const loggedIn = await loginUser('alice@acme.test', 'super-secret-123');
    expect(loggedIn.email).toBe('alice@acme.test');
  });

  it('rejects login with the wrong password', async () => {
    await registerWorkspace({
      workspaceName: 'Bad Password Co',
      ownerName: 'Bob',
      email: 'bob@acme.test',
      password: 'correct-password',
      acceptedTerms: true,
    });

    await expect(loginUser('bob@acme.test', 'wrong-password')).rejects.toThrow('Credenciais inválidas');
  });

  it('rejects registration without accepting terms', async () => {
    await expect(registerWorkspace({
      workspaceName: 'No Terms Inc',
      ownerName: 'Carol',
      email: 'carol@acme.test',
      password: 'whatever-123',
      acceptedTerms: false,
    })).rejects.toThrow('Termos de Uso');
  });

  it('rejects registering the same email twice', async () => {
    await registerWorkspace({
      workspaceName: 'First Co',
      ownerName: 'Dave',
      email: 'dave@acme.test',
      password: 'whatever-123',
      acceptedTerms: true,
    });

    await expect(registerWorkspace({
      workspaceName: 'Second Co',
      ownerName: 'Dave Again',
      email: 'dave@acme.test',
      password: 'whatever-456',
      acceptedTerms: true,
    })).rejects.toThrow('já cadastrado');
  });
});
