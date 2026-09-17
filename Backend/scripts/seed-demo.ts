/**
 * One-off demo-data seed for a sales case study. Creates a brand-new, fully
 * isolated workspace ("Loja Aurora") owned by teste@teste.com with realistic
 * team, contacts, conversations + message history spread over ~90 days,
 * CRM pipeline/leads, ratings, labels, close reasons and automations — enough
 * for every screen (Conversas, Contatos, CRM, Reports, Equipe, Automação) to
 * look like a real, lived-in account instead of an empty new signup.
 *
 * Run once: npx tsx scripts/seed-demo.ts
 * Safe to re-run: bails out if teste@teste.com already exists instead of
 * creating a duplicate workspace.
 */
import 'dotenv/config';
import mongoose, { Types } from 'mongoose';
import {
  Workspace, User, Instance, TeamGroup, Label, CloseReason,
  Contact, Conversation, Message, Pipeline, Lead, Flow, Rating,
} from '../src/db/models';
import { registerWorkspace } from '../src/modules/auth/auth.service';
import { getOrCreateSubscription, changePlan } from '../src/modules/billing/billing.service';

// ── RNG helpers ────────────────────────────────────────────────────────────

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function pickN<T>(arr: T[], n: number): T[] {
  const copy = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
  return out;
}
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function chance(p: number): boolean {
  return Math.random() < p;
}
/** Days-ago, weighted toward recent (so activity looks like organic real usage, not a flat dump). */
function weightedDaysAgo(maxDays: number): number {
  return Math.floor(Math.pow(Math.random(), 1.6) * maxDays);
}
function daysAgo(n: number, hour = randInt(8, 20), minute = randInt(0, 59)): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, randInt(0, 59), 0);
  return d;
}
function minutesAfter(d: Date, min: number): Date {
  return new Date(d.getTime() + min * 60_000);
}

// ── Name / phone pools ───────────────────────────────────────────────────────

const FIRST = ['Ana','Bruno','Carla','Diego','Elaine','Fábio','Gabriela','Hugo','Isabela','João','Karina','Lucas','Mariana','Nicolas','Olívia','Paulo','Queila','Rafael','Sabrina','Thiago','Uiara','Vinícius','Wesley','Yasmin','Camila','Rodrigo','Beatriz','Felipe','Larissa','Gustavo','Patrícia','Eduardo','Juliana','Marcelo','Renata','André','Vanessa','Leonardo','Priscila','Daniel'];
const LAST = ['Silva','Souza','Oliveira','Santos','Pereira','Costa','Rodrigues','Almeida','Nascimento','Lima','Araújo','Ferreira','Carvalho','Gomes','Martins','Rocha','Ribeiro','Alves','Monteiro','Cardoso','Teixeira','Barbosa','Moreira','Correia'];
function randomName(): string { return `${pick(FIRST)} ${pick(LAST)}`; }
function randomPhone(): string {
  const ddd = pick(['11','21','31','41','51','61','71','81','85','47','48']);
  return `55${ddd}9${randInt(1000, 9999)}${randInt(1000, 9999)}`;
}

// ── Conversation topic templates (inbound → outbound pairs) ─────────────────

type Exchange = { in: string; out: string };
const TOPICS: Record<string, Exchange[]> = {
  duvida_produto: [
    { in: 'Oi! Vi o vestido midi floral no Instagram, ainda tem no tamanho M?', out: 'Oi! Tudo bem? Deixa eu conferir o estoque pra você 😊 Um instante!' },
    { in: 'Claro, obrigada!', out: 'Temos sim! M e G disponíveis em 3 cores. Quer que eu te mande fotos?' },
    { in: 'Manda sim, por favor', out: '[imagem] Aqui está! Esse é o off-white, super queridinho essa semana.' },
    { in: 'Adorei esse! Qual o valor?', out: 'Sai por R$ 189,90, com frete grátis pra compras acima de R$ 150 😉' },
    { in: 'Perfeito, vou querer! Como faço pra comprar?', out: 'Te mando o link do checkout agora, é só finalizar por lá!' },
  ],
  status_pedido: [
    { in: 'Boa tarde! Meu pedido #4821 já foi enviado?', out: 'Boa tarde! Vou verificar aqui pra você, um momentinho.' },
    { in: 'Obrigada, aguardo', out: 'Consegui aqui — saiu do nosso CD ontem, código de rastreio: BR4821XXXX' },
    { in: 'Ótimo! Previsão de chegada?', out: 'Em média 5 a 7 dias úteis pra sua região. Qualquer coisa me chama!' },
    { in: 'Perfeito, muito obrigada pela atenção!', out: 'Disponha! Qualquer dúvida é só chamar 💛' },
  ],
  troca_tamanho: [
    { in: 'Olá, comprei uma calça e veio um tamanho menor que o normal, dá pra trocar?', out: 'Olá! Poxa, sinto muito pelo transtorno. Sem problemas, fazemos a troca sim!' },
    { in: 'Que bom! Como funciona?', out: 'Você me manda o número do pedido que eu já gero a etiqueta de devolução reversa, sem custo.' },
    { in: 'Pedido #3390', out: 'Localizei aqui! Etiqueta enviada pro seu e-mail, é só postar nos Correios.' },
    { in: 'Show, muito obrigada pela agilidade!', out: 'Por nada! Assim que a peça chegar aqui, já despachamos a nova em até 2 dias úteis.' },
  ],
  reclamacao: [
    { in: 'Gente, comprei há 10 dias e até agora nada chegou, isso é sério?', out: 'Poxa, peço desculpas pela demora! Deixa eu rastrear seu pedido agora mesmo.' },
    { in: 'Por favor, já paguei e preciso pra um evento', out: 'Entendo perfeitamente. Encontrei aqui — está parado num centro de triagem, vou abrir um chamado urgente com a transportadora.' },
    { in: 'Ok, fico no aguardo então', out: 'Vou te dar um retorno em até 24h com uma posição, combinado? Se preferir, também posso oferecer o reembolso.' },
    { in: 'Vamos tentar resolver primeiro, obrigada por entender', out: 'Combinado! Já registrei aqui a prioridade, vou te atualizar assim que tiver novidade.' },
  ],
  interesse_geral: [
    { in: 'Oi, vocês têm loja física ou é só online?', out: 'Oi! Somos 100% online, mas entregamos pra todo o Brasil 😊' },
    { in: 'Entendi. Vocês fazem promoção de aniversário da loja?', out: 'Fazemos sim! Esse mês está rolando até 30% off em peças selecionadas, quer que eu separe algumas pra você?' },
    { in: 'Quero sim, adoro roupas de festa', out: 'Perfeito! Me conta seu estilo/tamanho que eu já monto uma seleção certinha.' },
  ],
  pagamento: [
    { in: 'Oi, fiz o pix mas ainda não caiu aqui no sistema de vocês', out: 'Oi! Deixa eu verificar, às vezes leva alguns minutinhos pra compensar.' },
    { in: 'Já fazem 20 minutos', out: 'Localizei o pagamento aqui, já confirmado! Seu pedido já entrou em produção.' },
    { in: 'Ufa, que bom! Obrigada', out: 'Isso! Qualquer coisa estou à disposição 💛' },
  ],
};
const TOPIC_KEYS = Object.keys(TOPICS);

// ── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI não definido');
  await mongoose.connect(uri);
  console.log('[seed] conectado ao MongoDB');

  const existing = await User.findOne({ email: 'teste@teste.com' });
  if (existing) {
    console.log('[seed] teste@teste.com já existe (workspace ' + existing.workspaceId + ') — abortando pra não duplicar.');
    await mongoose.disconnect();
    return;
  }

  // ── Workspace + owner (reuses the real registration path: password hashing,
  // slug generation, trial subscription — same as a genuine signup) ──────────
  const { user: owner, workspaceId } = await registerWorkspace({
    workspaceName: 'Loja Aurora',
    ownerName: 'Marina Duarte',
    email: 'teste@teste.com',
    password: '##Teste!Prod',
    acceptedTerms: true,
  });
  const wsId = new Types.ObjectId(workspaceId);
  console.log('[seed] workspace criado:', workspaceId);

  // Bump straight to Profissional (case study should show a paid-tier account, not a bare trial).
  await changePlan(workspaceId, 'plan-pro', 'annual');

  owner.availability = 'available';
  owner.role = 'owner';
  await owner.save();

  // ── Team ──────────────────────────────────────────────────────────────────
  const teamNames = [
    { name: 'Camila Rocha', role: 'admin' as const },
    { name: 'Rafael Nogueira', role: 'agent' as const },
    { name: 'Beatriz Lins', role: 'agent' as const },
    { name: 'Diego Farias', role: 'agent' as const },
    { name: 'Juliana Prado', role: 'agent' as const },
  ];
  const agents = [];
  for (const t of teamNames) {
    const u = await User.create({
      workspaceId: wsId, name: t.name, email: `${t.name.split(' ')[0].toLowerCase()}@lojaaurora.com.br`,
      passwordHash: 'DemoSenha123!', role: t.role, isActive: true, termsAcceptedAt: new Date(),
      availability: pick(['available', 'available', 'busy', 'offline']), maxConcurrentChats: randInt(5, 15),
    });
    agents.push(u);
  }
  const allAgents = [owner, ...agents];
  console.log('[seed] equipe criada:', allAgents.length, 'pessoas');

  const teamVendas = await TeamGroup.create({
    workspaceId: wsId, name: 'Vendas', emoji: '💰', color: '#10B981',
    description: 'Atendimento comercial e novos pedidos',
    leadId: agents[0]._id, memberIds: [agents[0]._id, agents[1]._id, agents[2]._id],
    routingStrategy: 'least_busy',
  });
  const teamSuporte = await TeamGroup.create({
    workspaceId: wsId, name: 'Suporte', emoji: '🎧', color: '#3B82F6',
    description: 'Trocas, devoluções e pós-venda',
    leadId: agents[3]._id, memberIds: [agents[3]._id, agents[4]._id],
    routingStrategy: 'round_robin',
  });
  console.log('[seed] equipes: Vendas, Suporte');

  // ── Instance ──────────────────────────────────────────────────────────────
  const instance = await Instance.create({
    workspaceId: wsId, name: 'Loja Aurora — Vendas', channel: 'baileys',
    phone: randomPhone(), status: 'connected', lastConnectedAt: daysAgo(0, 8, 0),
  });
  console.log('[seed] instância criada:', instance.name);

  // ── Labels ────────────────────────────────────────────────────────────────
  const labelDefs = [
    { name: 'Cliente VIP', color: '#F59E0B' },
    { name: 'Novo Lead', color: '#3B82F6' },
    { name: 'Recorrente', color: '#10B981' },
    { name: 'Aguardando Pagamento', color: '#8B5CF6' },
    { name: 'Reclamação', color: '#EF4444' },
    { name: 'Pós-venda', color: '#06B6D4' },
  ];
  for (const l of labelDefs) await Label.create({ workspaceId: wsId, ...l });
  console.log('[seed] etiquetas:', labelDefs.length);

  // ── Close reasons ─────────────────────────────────────────────────────────
  const crResolvido = await CloseReason.create({ workspaceId: wsId, label: 'Resolvido', color: '#10B981' });
  const crSemResposta = await CloseReason.create({ workspaceId: wsId, label: 'Cliente não respondeu', color: '#F59E0B' });
  const crVenda = await CloseReason.create({ workspaceId: wsId, label: 'Venda concluída', color: '#3B82F6' });
  const closeReasons = [crResolvido, crResolvido, crResolvido, crVenda, crSemResposta]; // weighted

  // ── CRM Pipeline ──────────────────────────────────────────────────────────
  const stages = [
    { id: 'novo', name: 'Novo Lead', order: 0, color: '#3B82F6', kind: 'open' as const, probability: 10 },
    { id: 'qualificacao', name: 'Qualificação', order: 1, color: '#8B5CF6', kind: 'open' as const, probability: 30 },
    { id: 'proposta', name: 'Proposta Enviada', order: 2, color: '#F59E0B', kind: 'open' as const, probability: 55 },
    { id: 'negociacao', name: 'Negociação', order: 3, color: '#EC4899', kind: 'open' as const, probability: 75 },
    { id: 'ganho', name: 'Ganho', order: 4, color: '#10B981', kind: 'won' as const, probability: 100 },
    { id: 'perdido', name: 'Perdido', order: 5, color: '#64748B', kind: 'lost' as const, probability: 0 },
  ];
  const pipeline = await Pipeline.create({
    workspaceId: wsId, name: 'Vendas', description: 'Funil comercial da Loja Aurora',
    stages, isDefault: true, autoCreateFromConversation: false,
  });
  console.log('[seed] pipeline criado com', stages.length, 'estágios');

  // ── Automations (flows) — minimal valid node/edge graphs ────────────────
  function simpleFlow(name: string, description: string, keywords: string[], nodes: { id: string; blockType: string; config: Record<string, unknown> }[]) {
    const edges = nodes.slice(0, -1).map((n, i) => ({ id: `e${i}`, source: n.id, sourceHandle: 'out', target: nodes[i + 1].id, targetHandle: null }));
    return Flow.create({
      workspaceId: wsId, name, description, enabled: true,
      trigger: { type: 'keyword' as const, keywords, allowGroups: false },
      nodes: [{ id: 'trigger', blockType: 'automation.trigger', config: { triggerType: 'keyword', keywords, allowGroups: false } }, ...nodes],
      edges: [{ id: 'e-trigger', source: 'trigger', sourceHandle: 'out', target: nodes[0].id, targetHandle: null }, ...edges],
    });
  }
  await simpleFlow('Boas-vindas', 'Recepciona novo contato e explica como podemos ajudar', ['oi', 'olá', 'ola', 'bom dia', 'boa tarde'], [
    { id: 'msg1', blockType: 'message.text', config: { content: 'Oi! Seja bem-vindo(a) à Loja Aurora 💛 Como posso te ajudar hoje?', delay: 0 } },
  ]);
  await simpleFlow('FAQ — Tamanhos e Trocas', 'Responde dúvidas comuns sobre tabela de tamanhos', ['tamanho', 'troca', 'medidas'], [
    { id: 'msg1', blockType: 'message.text', config: { content: 'Nossa tabela de tamanhos vai do PP ao GG. Trocas são gratuitas em até 30 dias após a compra!', delay: 0 } },
  ]);
  await simpleFlow('Encerrar com Avaliação', 'Fecha o atendimento e pede uma nota de satisfação', ['obrigada', 'obrigado', 'valeu'], [
    { id: 'rate', blockType: 'attendance.rate', config: { prompt: 'De 1 a 5, como você avalia nosso atendimento hoje?', askComment: true, commentPrompt: 'Quer deixar mais algum comentário? (opcional)' } },
    { id: 'close', blockType: 'attendance.close', config: { message: 'Muito obrigada pelo contato! Até a próxima 💛', closeReasonId: crResolvido._id.toString() } },
  ]);
  console.log('[seed] 3 automações criadas e ativas');

  // ── Contacts ──────────────────────────────────────────────────────────────
  const CONTACT_COUNT = 45;
  const contacts = [];
  for (let i = 0; i < CONTACT_COUNT; i++) {
    const name = randomName();
    const phone = randomPhone();
    const createdDaysAgo = weightedDaysAgo(120) + 5; // contacts predate their conversations a bit
    const tags: string[] = [];
    if (chance(0.15)) tags.push('Cliente VIP');
    if (chance(0.2)) tags.push('Recorrente');
    if (chance(0.1)) tags.push('Novo Lead');
    if (chance(0.08)) tags.push('Reclamação');
    const c = await Contact.create({
      workspaceId: wsId, jid: `${phone}@s.whatsapp.net`, phone, name,
      pushName: name.split(' ')[0], tags,
      status: chance(0.04) ? 'blocked' : 'active', source: 'whatsapp',
      conversationCount: 0, lastSeenAt: daysAgo(weightedDaysAgo(30)),
      createdAt: daysAgo(createdDaysAgo), updatedAt: daysAgo(weightedDaysAgo(30)),
    });
    contacts.push(c);
  }
  console.log('[seed] contatos criados:', contacts.length);

  // ── Conversations + Messages ──────────────────────────────────────────────
  const CONVERSATION_COUNT = 40;
  let ratingsCreated = 0;
  for (let i = 0; i < CONVERSATION_COUNT; i++) {
    const contact = contacts[i % contacts.length];
    const topicKey = pick(TOPIC_KEYS);
    const exchanges = TOPICS[topicKey];
    const usedExchanges = exchanges.slice(0, randInt(2, exchanges.length));
    const startDaysAgo = weightedDaysAgo(90);
    const agent = pick(allAgents.filter((a) => a._id.toString() !== owner._id.toString())) ?? owner;
    const team = topicKey === 'reclamacao' || topicKey === 'troca_tamanho' ? teamSuporte : teamVendas;

    // Status distribution: mostly resolved (realistic for a lived-in inbox), some open/pending/snoozed.
    const roll = Math.random();
    const status: 'open' | 'pending' | 'resolved' | 'snoozed' =
      startDaysAgo < 2 ? pick(['open', 'pending', 'open']) :
      roll < 0.72 ? 'resolved' : roll < 0.85 ? 'pending' : roll < 0.95 ? 'open' : 'snoozed';

    let cursor = daysAgo(startDaysAgo);
    const firstInbound = cursor;
    const messages: Record<string, unknown>[] = [];
    let lastMsg: { content: string; type: string; direction: 'inbound' | 'outbound'; timestamp: Date } | null = null;

    for (const ex of usedExchanges) {
      const inTs = cursor;
      messages.push({
        _id: new Types.ObjectId(), workspaceId: wsId, instanceId: instance._id, conversationId: null,
        jid: contact.jid, messageId: `demo-${new Types.ObjectId().toString()}`, direction: 'inbound', type: 'text',
        status: 'read', fromMe: false, content: { text: ex.in }, senderName: contact.name,
        createdAt: inTs, updatedAt: inTs,
      });
      lastMsg = { content: ex.in, type: 'text', direction: 'inbound', timestamp: inTs };
      cursor = minutesAfter(cursor, randInt(1, 6));
      const outTs = cursor;
      messages.push({
        _id: new Types.ObjectId(), workspaceId: wsId, instanceId: instance._id, conversationId: null,
        jid: contact.jid, messageId: `demo-${new Types.ObjectId().toString()}`, direction: 'outbound', type: 'text',
        status: 'read', fromMe: true, content: { text: ex.out }, agentId: agent._id,
        createdAt: outTs, updatedAt: outTs,
      });
      lastMsg = { content: ex.out, type: 'text', direction: 'outbound', timestamp: outTs };
      cursor = minutesAfter(cursor, randInt(15, 240));
    }

    const resolvedAt = status === 'resolved' ? minutesAfter(lastMsg!.timestamp, randInt(1, 30)) : undefined;
    const firstRespondedAt = minutesAfter(firstInbound, randInt(1, 6));
    const slaBreached = chance(0.08);

    const conv = await Conversation.create({
      workspaceId: wsId, instanceId: instance._id, jid: contact.jid, name: contact.name, phone: contact.phone,
      status, assignedAgentId: status === 'resolved' || status === 'pending' || status === 'open' ? agent._id : undefined,
      unreadCount: status === 'open' ? randInt(0, 2) : 0,
      lastMessage: lastMsg!, isGroup: false, contactId: contact._id, teamGroupId: team._id,
      attendanceMode: chance(0.25) ? 'bot' : 'human',
      firstRespondedAt, firstResponseDueAt: undefined,
      slaFirstResponseBreached: slaBreached, slaResolutionBreached: status === 'resolved' && chance(0.05),
      closeReasonId: status === 'resolved' ? pick(closeReasons)._id : undefined,
      resolvedAt, lastInboundAt: firstInbound,
      createdAt: firstInbound, updatedAt: resolvedAt ?? lastMsg!.timestamp,
    });

    for (const m of messages) (m as Record<string, unknown>).conversationId = conv._id;
    await Message.insertMany(messages);

    // CSAT: only for resolved conversations closed via the rating flow topic-ish — sample a subset.
    if (status === 'resolved' && chance(0.4)) {
      const score = chance(0.7) ? randInt(4, 5) : randInt(2, 5);
      await Rating.create({
        workspaceId: wsId, conversationId: conv._id, contactId: contact._id,
        agentId: agent._id, teamGroupId: team._id, score,
        comment: score >= 4 ? pick(['Atendimento rápido e gentil!', 'Adorei, super atenciosos.', 'Resolveram tudo rapidinho, recomendo!', undefined, undefined]) : pick(['Poderia ser mais rápido.', 'Poderia ter mais opções de cor.', undefined]),
        createdAt: resolvedAt,
      });
      ratingsCreated++;
    }
  }
  console.log('[seed] conversas criadas:', CONVERSATION_COUNT, '| avaliações:', ratingsCreated);

  // ── CRM Leads ─────────────────────────────────────────────────────────────
  const LEAD_COUNT = 26;
  const leadContacts = pickN(contacts, Math.min(LEAD_COUNT, contacts.length));
  const productTitles = ['Vestido midi floral', 'Conjunto alfaiataria', 'Blazer oversized', 'Calça wide leg', 'Saia plissada', 'Blusa cropped', 'Macacão jeans', 'Vestido de festa', 'Kit 3 blusas básicas', 'Trench coat'];
  for (let i = 0; i < leadContacts.length; i++) {
    const contact = leadContacts[i];
    const stage = pick(stages);
    const assignee = pick(allAgents.filter((a) => a._id.toString() !== owner._id.toString()));
    const createdDaysAgo = weightedDaysAgo(75);
    const value = randInt(15, 45) * 10 + randInt(0, 9) * 10 + 0.9; // R$ 150-500ish, .90 endings
    const isWon = stage.kind === 'won';
    const isLost = stage.kind === 'lost';
    await Lead.create({
      workspaceId: wsId, pipelineId: pipeline._id, stageId: stage.id, contactId: contact._id,
      title: `${pick(productTitles)} — ${contact.name.split(' ')[0]}`,
      value: Math.round(value * 100) / 100, currency: 'BRL', assigneeId: assignee._id,
      tags: chance(0.2) ? ['Recorrente'] : [], status: isWon ? 'won' : isLost ? 'lost' : 'open',
      source: pick(['conversation', 'manual', 'conversation', 'conversation']),
      expectedCloseDate: !isWon && !isLost ? daysAgo(-randInt(3, 20)) : undefined,
      wonAt: isWon ? daysAgo(weightedDaysAgo(createdDaysAgo)) : undefined,
      lostAt: isLost ? daysAgo(weightedDaysAgo(createdDaysAgo)) : undefined,
      lostReason: isLost ? pick(['Preço acima do orçamento', 'Comprou em outra loja', 'Desistiu da compra']) : undefined,
      lastActivityAt: daysAgo(weightedDaysAgo(Math.min(createdDaysAgo, 20))),
      createdAt: daysAgo(createdDaysAgo), updatedAt: daysAgo(weightedDaysAgo(Math.min(createdDaysAgo, 20))),
    });
  }
  console.log('[seed] leads criados:', leadContacts.length);

  console.log('\n[seed] ✅ concluído.');
  console.log('[seed] login: teste@teste.com / ##Teste!Prod');
  console.log('[seed] workspace: Loja Aurora (' + workspaceId + ')');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('[seed] falhou:', err);
  await mongoose.disconnect();
  process.exit(1);
});
