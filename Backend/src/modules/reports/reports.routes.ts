import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { reportRange, reportDay, reportExcelDate } from './report-period';
import { buildReportSummary, findReportConversations, type ReportRow, type CloseReasonRow } from './reports.service';
import { clampAnalyticsFrom } from '../billing/billing.service';

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
    const { from: requestedFrom, to } = reportRange(q);
    const from = await clampAnalyticsFrom(workspaceId, requestedFrom);
    if (from > to) return reply.status(400).send({ error: 'Periodo indisponivel no historico do plano.' });
    const summary = await buildReportSummary({ workspaceId, from, to, teamGroupId: q.teamGroupId, agentId: q.agentId });
    return reply.header('Cache-Control', 'private, no-store').send({ data: summary });
  });

  // GET /api/reports/export — generates a multi-sheet .xlsx workbook for the same filters.
  fastify.get('/export', auth, async (request, reply) => {
    const { workspaceId, role } = request.user as { workspaceId: string; role: string };
    if (!requireManager(role, reply)) return;

    const q = request.query as Record<string, string>;
    const { from: requestedFrom, to } = reportRange(q);
    const from = await clampAnalyticsFrom(workspaceId, requestedFrom);
    if (from > to) return reply.status(400).send({ error: 'Periodo indisponivel no historico do plano.' });
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
      { metric: 'Periodo (de, Sao Paulo)', value: reportExcelDate(from) },
      { metric: 'Periodo (ate, Sao Paulo)', value: reportExcelDate(to) },
      { metric: 'Conversas criadas no período', value: summary.overview.totalCreated },
      { metric: 'Conversas abertas (atual)', value: summary.overview.openNow },
      { metric: 'Conversas finalizadas no período', value: summary.overview.resolvedInRange },
      { metric: 'Conversas com contato bloqueado', value: summary.overview.blocked },
      { metric: 'Saidas / entradas (%)', value: summary.overview.totalCreated ? summary.overview.resolutionRate : null },
      { metric: 'Tempo médio 1ª resposta (min)', value: summary.overview.avgFirstResponseMinutes ?? '—' },
      { metric: 'SLA 1ª resposta estourado (%)', value: summary.overview.slaFirstResponseBreachRate },
      { metric: 'SLA resolução estourado (%)', value: summary.overview.slaResolutionBreachRate },
      { metric: 'Atendimento — Bot', value: summary.attendanceMode.bot },
      { metric: 'Atendimento — Humano', value: summary.attendanceMode.human },
      { metric: 'Atendimento — Ocioso', value: summary.attendanceMode.idle },
      { metric: 'Nota média de satisfação (CSAT)', value: summary.csat.average ?? '—' },
      { metric: 'Avaliações recebidas', value: summary.csat.count },
    ]);
    summarySheet.getRow(1).font = { bold: true };
    summarySheet.getColumn('metric').width = 42;
    summarySheet.getColumn('value').width = 24;
    summarySheet.eachRow((row, index) => {
      if (index === 2 || index === 3) row.getCell(2).numFmt = 'dd/mm/yyyy hh:mm:ss';
      if (String(row.getCell(1).value).includes('(%)') && typeof row.getCell(2).value === 'number') {
        row.getCell(2).value = Number(row.getCell(2).value) / 100;
        row.getCell(2).numFmt = '0.0%';
      }
    });

    // ── Tendência Diária ──────────────────────────────────────────────────────
    const trendSheet = workbook.addWorksheet('Tendência Diária');
    trendSheet.columns = [
      { header: 'Data', key: 'date', width: 14 },
      { header: 'Criadas', key: 'created', width: 12 },
      { header: 'Finalizadas', key: 'resolved', width: 14 },
    ];
    trendSheet.addRows(summary.trend.map((row) => ({ ...row, date: new Date(`${row.date}T00:00:00Z`) })));
    trendSheet.getColumn('date').numFmt = 'dd/mm/yyyy';
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
        { header: 'Saidas / entradas', key: 'resolutionRate', width: 20 },
      ];
      sheet.addRows(rows.map((r) => ({ name: r.name, total: r.total, resolved: r.resolved, open: r.open, blocked: r.blocked, resolutionRate: r.total ? r.resolutionRate / 100 : null })));
      sheet.getColumn('resolutionRate').numFmt = '0.0%';
      sheet.getRow(1).font = { bold: true };
    }
    addBreakdownSheet('Por Equipe', 'Equipe', summary.byTeam);
    addBreakdownSheet('Por Atendente', 'Atendente', summary.byAgent);

    // ── Satisfação (CSAT) ─────────────────────────────────────────────────────
    const csatSheet = workbook.addWorksheet('Satisfação');
    csatSheet.columns = [{ header: 'Nota', key: 'label', width: 24 }, { header: 'Avaliações', key: 'count', width: 14 }];
    csatSheet.addRows(summary.csat.distribution.map((d) => ({ label: d.score, count: d.count })));
    for (const [name, rows] of [['CSAT por Atendente', summary.csat.byAgent], ['CSAT por Equipe', summary.csat.byTeam]] as const) {
      const sheet = workbook.addWorksheet(name);
      sheet.columns = [
        { header: 'Nome', key: 'name', width: 30 },
        { header: 'Media', key: 'average', width: 14 },
        { header: 'Avaliacoes', key: 'count', width: 14 },
      ];
      sheet.addRows(rows);
      sheet.getColumn('average').numFmt = '0.0';
    }
    csatSheet.getRow(1).font = { bold: true };

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
      { header: 'ID', key: 'id', width: 26 },
      { header: 'Criada no periodo', key: 'createdInPeriod', width: 20 },
      { header: 'Finalizada no periodo', key: 'resolvedInPeriod', width: 24 },
      { header: 'Aberta agora', key: 'openNow', width: 18 },
      { header: 'Bloqueada no periodo', key: 'blockedInPeriod', width: 24 },
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
      createdInPeriod: Number(c.createdInPeriod),
      resolvedInPeriod: Number(c.resolvedInPeriod),
      openNow: Number(c.openNow),
      blockedInPeriod: Number(c.blockedInPeriod),
      blocked: c.blocked ? 'Sim' : 'Não',
      createdAt: c.createdAt ? reportExcelDate(new Date(c.createdAt)) : null,
      resolvedAt: c.resolvedAt ? reportExcelDate(new Date(c.resolvedAt)) : null,
    })));
    detailSheet.getRow(1).font = { bold: true };
    detailSheet.getColumn('createdAt').numFmt = 'dd/mm/yyyy hh:mm:ss';
    detailSheet.getColumn('resolvedAt').numFmt = 'dd/mm/yyyy hh:mm:ss';
    detailSheet.getColumn('phone').numFmt = '@';

    const criteria = workbook.addWorksheet('Criterios');
    criteria.columns = [{ header: 'Campo', key: 'field', width: 28 }, { header: 'Valor', key: 'value', width: 100 }];
    criteria.addRows([
      { field: 'Fuso horario', value: 'America/Sao_Paulo. Datas do Excel representam o horario local.' },
      { field: 'Gerado em', value: reportExcelDate(workbook.created) },
      { field: 'Equipe (ID)', value: q.teamGroupId || 'Todas' },
      { field: 'Atendente (ID)', value: q.agentId || 'Todos' },
      { field: 'Criadas', value: 'Data de criacao dentro do periodo efetivo informado no Resumo.' },
      { field: 'Finalizadas', value: 'Status atual finalizado e data de resolucao no periodo; inclui conversas criadas antes.' },
      { field: 'Abertas', value: 'Status aberto no momento da consulta, sem restricao de data de criacao.' },
      { field: 'Bloqueadas', value: 'Criadas no periodo cujo contato esta bloqueado no momento da consulta.' },
      { field: 'Saidas / entradas', value: 'Finalizadas dividido por criadas. Pode superar 100%; vazio quando nao ha entradas.' },
      { field: 'Conversas detalhadas', value: 'Uniao dos grupos acima. Colunas 1/0 identificam quais totais cada conversa compoe.' },
      { field: 'Atendimento e SLA', value: 'Estado atual das conversas criadas no periodo. SLA usa todas as criadas como denominador.' },
      { field: 'CSAT', value: 'Avaliacoes recebidas no periodo, filtradas pela equipe e atendente da avaliacao.' },
      { field: 'Atualizacao', value: 'Dados consultados durante a geracao; operacoes simultaneas podem alterar os totais entre consultas.' },
    ]);
    criteria.getCell('B3').numFmt = 'dd/mm/yyyy hh:mm:ss';
    for (const sheet of workbook.worksheets) {
      sheet.views = [{ state: 'frozen', ySplit: 1 }];
      sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columnCount } };
      sheet.getRow(1).height = 28;
      sheet.getRow(1).eachCell((cell) => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF185D63' } };
      });
    }

    const buffer = await workbook.xlsx.writeBuffer();
    reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="relatorio-${reportDay(from)}-a-${reportDay(to)}.xlsx"`)
      .header('Cache-Control', 'private, no-store')
      .send(Buffer.from(buffer));
  });
}
