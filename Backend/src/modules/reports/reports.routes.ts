import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { resolveDateRange, isoDate } from '../../shared/date-range';
import { buildReportSummary, findReportConversations, type ReportRow, type CloseReasonRow } from './reports.service';

function requireManager(role: string, reply: import('fastify').FastifyReply): boolean {
  if (!['owner', 'admin'].includes(role)) {
    reply.status(403).send({ error: 'Sem permissão' });
    return false;
  }
  return true;
}

export async function reportsRoutes(fastify: FastifyInstance): Promise<void> {
  const auth = { preHandler: [fastify.authenticate] };

  // GET /api/reports/summary
  fastify.get('/summary', auth, async (request, reply) => {
    const { workspaceId, role } = request.user as { workspaceId: string; role: string };
    if (!requireManager(role, reply)) return;

    const q = request.query as Record<string, string>;
    const { from, to } = resolveDateRange(q);
    const summary = await buildReportSummary({ workspaceId, from, to, teamGroupId: q.teamGroupId, agentId: q.agentId });
    return reply.send({ data: summary });
  });

  // GET /api/reports/export — generates a multi-sheet .xlsx workbook for the same filters.
  fastify.get('/export', auth, async (request, reply) => {
    const { workspaceId, role } = request.user as { workspaceId: string; role: string };
    if (!requireManager(role, reply)) return;

    const q = request.query as Record<string, string>;
    const { from, to } = resolveDateRange(q);
    const filters = { workspaceId, from, to, teamGroupId: q.teamGroupId, agentId: q.agentId };

    const [summary, conversations] = await Promise.all([
      buildReportSummary(filters),
      findReportConversations(filters),
    ]);

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'ZapZin';
    workbook.created = new Date();

    // ── Resumo ──────────────────────────────────────────────────────────────
    const summarySheet = workbook.addWorksheet('Resumo');
    summarySheet.columns = [{ header: 'Métrica', key: 'metric', width: 32 }, { header: 'Valor', key: 'value', width: 16 }];
    summarySheet.addRows([
      { metric: 'Período (de)', value: isoDate(from) },
      { metric: 'Período (até)', value: isoDate(to) },
      { metric: 'Conversas criadas no período', value: summary.overview.totalCreated },
      { metric: 'Conversas abertas (atual)', value: summary.overview.openNow },
      { metric: 'Conversas finalizadas no período', value: summary.overview.resolvedInRange },
      { metric: 'Conversas com contato bloqueado', value: summary.overview.blocked },
      { metric: 'Taxa de resolução (%)', value: summary.overview.resolutionRate },
      { metric: 'Tempo médio 1ª resposta (min)', value: summary.overview.avgFirstResponseMinutes ?? '—' },
      { metric: 'SLA 1ª resposta estourado (%)', value: summary.overview.slaFirstResponseBreachRate },
      { metric: 'SLA resolução estourado (%)', value: summary.overview.slaResolutionBreachRate },
      { metric: 'Atendimento — Bot', value: summary.attendanceMode.bot },
      { metric: 'Atendimento — Humano', value: summary.attendanceMode.human },
      { metric: 'Atendimento — Ocioso', value: summary.attendanceMode.idle },
    ]);
    summarySheet.getRow(1).font = { bold: true };

    // ── Tendência Diária ──────────────────────────────────────────────────────
    const trendSheet = workbook.addWorksheet('Tendência Diária');
    trendSheet.columns = [
      { header: 'Data', key: 'date', width: 14 },
      { header: 'Criadas', key: 'created', width: 12 },
      { header: 'Finalizadas', key: 'resolved', width: 14 },
    ];
    trendSheet.addRows(summary.trend);
    trendSheet.getRow(1).font = { bold: true };

    // ── Por Equipe / Por Atendente (shared shape) ────────────────────────────
    function addBreakdownSheet(name: string, label: string, rows: ReportRow[]) {
      const sheet = workbook.addWorksheet(name);
      sheet.columns = [
        { header: label, key: 'name', width: 28 },
        { header: 'Total criadas', key: 'total', width: 16 },
        { header: 'Finalizadas', key: 'resolved', width: 14 },
        { header: 'Abertas (atual)', key: 'open', width: 16 },
        { header: 'Bloqueadas', key: 'blocked', width: 14 },
        { header: 'Taxa resolução (%)', key: 'resolutionRate', width: 18 },
      ];
      sheet.addRows(rows.map((r) => ({ name: r.name, total: r.total, resolved: r.resolved, open: r.open, blocked: r.blocked, resolutionRate: r.resolutionRate })));
      sheet.getRow(1).font = { bold: true };
    }
    addBreakdownSheet('Por Equipe', 'Equipe', summary.byTeam);
    addBreakdownSheet('Por Atendente', 'Atendente', summary.byAgent);

    // ── Motivos de Encerramento ───────────────────────────────────────────────
    const reasonSheet = workbook.addWorksheet('Motivos de Encerramento');
    reasonSheet.columns = [
      { header: 'Motivo', key: 'label', width: 26 },
      { header: 'Total', key: 'total', width: 12 },
      { header: 'Por equipe', key: 'byTeam', width: 50 },
      { header: 'Por atendente', key: 'byAgent', width: 50 },
    ];
    reasonSheet.addRows(summary.closeReasons.map((r: CloseReasonRow) => ({
      label: r.label,
      total: r.total,
      byTeam: r.byTeam.map((t) => `${t.name}: ${t.count}`).join('; '),
      byAgent: r.byAgent.map((a) => `${a.name}: ${a.count}`).join('; '),
    })));
    reasonSheet.getRow(1).font = { bold: true };

    // ── Conversas (detalhado) ─────────────────────────────────────────────────
    const detailSheet = workbook.addWorksheet('Conversas');
    detailSheet.columns = [
      { header: 'Nome', key: 'name', width: 24 },
      { header: 'Telefone', key: 'phone', width: 16 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Equipe', key: 'team', width: 20 },
      { header: 'Atendente', key: 'agent', width: 20 },
      { header: 'Etiquetas', key: 'tags', width: 24 },
      { header: 'Bloqueada', key: 'blocked', width: 12 },
      { header: 'Motivo de encerramento', key: 'closeReason', width: 22 },
      { header: 'Criada em', key: 'createdAt', width: 20 },
      { header: 'Resolvida em', key: 'resolvedAt', width: 20 },
    ];
    detailSheet.addRows(conversations.map((c) => ({
      ...c,
      blocked: c.blocked ? 'Sim' : 'Não',
      createdAt: c.createdAt ? new Date(c.createdAt).toLocaleString('pt-BR') : '',
      resolvedAt: c.resolvedAt ? new Date(c.resolvedAt).toLocaleString('pt-BR') : '',
    })));
    detailSheet.getRow(1).font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="relatorio-${isoDate(from)}-a-${isoDate(to)}.xlsx"`)
      .send(Buffer.from(buffer));
  });
}
