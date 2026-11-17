/* Append-only evidence repair. Run preflight and isolated rehearsal before --apply. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const apiRoot = process.env.REPAIR_API_ROOT || path.resolve(__dirname, '../apps/api');
require(path.join(apiRoot, 'node_modules/reflect-metadata'));
const { PrismaClient } = require(path.join(apiRoot, 'node_modules/@prisma/client'));
const { computeCompleteness, computeCredibility } = require(path.join(apiRoot, 'dist/domain/quality'));
const { parseDateTime, endOfDayIfNeeded, deriveRegistrationStatus } = require(path.join(apiRoot, 'dist/domain/time'));
const { AuditService } = require(path.join(apiRoot, 'dist/platform/audit.module'));
const directory = process.env.REPAIR_DIR || path.resolve(__dirname, '../artifacts/competition-information-repair-20261117');
const manifestText = fs.readFileSync(path.join(directory, 'repair-manifest.json'), 'utf8');
const manifest = JSON.parse(manifestText);
const probes = new Map(JSON.parse(fs.readFileSync(path.join(directory, 'entry-probes.json'), 'utf8')).rows.map(p => [p.url, p]));
const before = JSON.parse(fs.readFileSync(path.join(directory, 'before/database-snapshot.json'), 'utf8')).rows;
const beforeById = new Map(before.map(r => [r.id, r]));
const resultFile = path.join(directory, process.env.REPAIR_RESULT || 'execution.json');
const prisma = new PrismaClient();
const actorId = 'system:information-repair-ai-assisted';
const apply = process.argv.includes('--apply');
const now = new Date();
const save = value => fs.writeFileSync(resultFile, JSON.stringify(value, null, 2));
const normUrl = url => { try { return new URL(url).href.replace(/\/$/, ''); } catch { return url; } };
const has = v => v != null && String(v).trim() && !/^(待补充|待公布|待定|暂无|to_be_announced|详见官网|以官方通知为准)$/.test(String(v).trim());
const allowed = new Set(['description', 'organizers', 'eligibility', 'signupMethod', 'signupNote', 'signupUrl', 'signupContact', 'scheduleNote', 'nearestDeadline']);
const include = { sources: true, stages: true, entries: true, fieldEvidence: true,
  organizers: { include: { organizer: true } }, documentLinks: true };

function inspection(entry, decision) {
  const probe = entry.url ? probes.get(entry.url) : null;
  if (entry.url && !probe) throw new Error('Missing reachability observation');
  return { status: probe?.status || 'unverified', lastCheckedAt: probe ? new Date(probe.checkedAt) : now,
    // Evidence for a link is not a domain security allow-list.
    trustedDomain: false,
    internalReason: JSON.stringify({ repairId: manifest.repairId, sourceUrl: decision?.evidence?.url || null,
      scope: decision?.scope || 'existing_entry_scope_unchanged',
      checkKind: probe ? 'public_http_get_no_submission' : 'notice_workflow_review_no_web_form',
      observation: probe || { checkedAt: now.toISOString(), reason: '已核对通知中的组织/线下流程，无个人网页，不等于网页访问成功', submissionTested: false },
    }),
  };
}

async function preflight() {
  if (manifest.rowCount !== 72 || manifest.rows.length !== 72 || manifest.publicationPolicy !== 'preserve') throw new Error('Wrong scope/policy');
  if (new Set(manifest.rows.map(r => r.id)).size !== 72) throw new Error('Duplicate row');
  for (const d of manifest.rows) {
    const r = await prisma.competition.findUniqueOrThrow({ where: { id: d.id }, include });
    if (r.name !== d.name || r.versionNo !== d.expectedVersion || r.publishStatus !== d.publishStatus ||
        r.deletedAt || r.parentId || r.demoFlag || r.dataOrigin !== 'formal') throw new Error(`Identity/version drift: ${d.index}`);
    if (r.fieldEvidence.some(e => e.fieldName === 'informationRepairReview' && e.fieldValue?.includes(manifest.repairId))) throw new Error('Already applied; inspect before recovery');
    for (const f of d.fields) {
      if (!allowed.has(f.key) || !has(f.value) || !f.evidence?.snippet || !f.evidence?.sha256 || !f.scope) throw new Error('Invalid field decision');
      if (f.key === 'nearestDeadline' && !parseDateTime(f.value).at) throw new Error('Unparseable date');
    }
    for (const e of [...r.entries, ...d.entries]) if (e.url && !probes.has(e.url)) throw new Error('Unprobed entry');
    for (const s of d.stages) {
      const end = parseDateTime(s.end || ''); const start = parseDateTime(s.start || '');
      if (!end.at || (start.at && Date.parse(start.at) > Date.parse(end.at))) throw new Error('Bad scoped stage');
    }
    if (!beforeById.has(d.id)) throw new Error('No baseline');
  }
  return { prepared: manifest.rows.length, decisions: manifest.rows.reduce((n, d) => n + d.fields.length, 0),
    manifestSha256: crypto.createHash('sha256').update(manifestText).digest('hex'), mode: apply ? 'apply' : 'read_only' };
}

async function repair(d) {
  return prisma.$transaction(async tx => {
    const original = await tx.competition.findUniqueOrThrow({ where: { id: d.id }, include });
    if (original.versionNo !== d.expectedVersion || original.publishStatus !== d.publishStatus) throw new Error('Concurrent edit; preserving it');
    const data = { versionNo: { increment: 1 } };
    const changes = [];
    const eligibility = JSON.parse(original.eligibilityJson || '{}');
    const scopes = {};
    const sourceIds = new Map(original.sources.filter(s => s.url).map(s => [normUrl(s.url), s.id]));
    async function source(ev) {
      const key = normUrl(ev.url);
      if (!sourceIds.has(key)) {
        const s = await tx.sourceMaterial.create({ data: { competitionId: d.id, type: ev.sourceType,
          title: ev.title || ev.url, url: new URL(ev.url).href, ownerId: actorId } });
        sourceIds.set(key, s.id);
      }
      return sourceIds.get(key);
    }
    async function evidence(key, value, scope, ev) {
      const sourceId = await source(ev);
      await tx.fieldEvidence.create({ data: { competitionId: d.id, fieldName: key,
        fieldValue: typeof value === 'string' ? value : JSON.stringify(value), sourceId, sourceTitle: ev.title,
        snippet: ev.snippet, extractMethod: 'manual', manuallyCorrected: true, confidence: 'medium', fieldState: 'explicit',
        locationJson: JSON.stringify({ kind: 'web', url: ev.url, repairId: manifest.repairId,
          scope, cacheFile: ev.cacheFile, sha256: ev.sha256, checkedAt: ev.checkedAt, verification: 'AI-assisted-source-review' }),
      } });
    }
    for (const f of d.fields) {
      scopes[f.key] = f.scope;
      if (f.key === 'organizers') {
        for (const name of f.value) {
          const normalizedName = name.replace(/\s+/g, '').toLowerCase();
          const organizer = await tx.organizer.upsert({ where: { normalizedName }, update: {}, create: { name, normalizedName } });
          await tx.competitionOrganizer.upsert({ where: { competitionId_organizerId_role: { competitionId: d.id, organizerId: organizer.id, role: 'host' } },
            update: {}, create: { competitionId: d.id, organizerId: organizer.id, role: 'host' } });
        }
      } else if (f.key === 'eligibility') {
        eligibility.eligibility = f.value;
        data.eligibilityJson = JSON.stringify(eligibility);
      } else if (f.key === 'nearestDeadline') {
        const parsed = parseDateTime(f.value);
        data.nearestDeadline = parsed.at ? new Date(parsed.at) : null;
      } else data[f.key] = f.value;
      changes.push({ field: f.key, before: f.key === 'organizers' ? original.organizers.map(o => o.organizer.name) : original[f.key] ?? null, after: f.value, scope: f.scope });
      await evidence(f.key === 'organizers' ? 'organizer' : f.key, f.value, f.scope, f.evidence);
    }
    for (const timing of d.stages) {
      const start = parseDateTime(timing.start || ''), end = parseDateTime(timing.end);
      const values = { name: timing.name, stageType: 'official', startAt: start.at ? new Date(start.at) : null,
        startPrecision: start.precision, startTimezone: start.timezone, startRawText: timing.start,
        endAt: new Date(end.at), endPrecision: end.precision, endTimezone: end.timezone,
        endRawText: timing.end, applicableTo: timing.applicableTo };
      const previous = timing.replaceOfficialFirst ? original.stages.filter(s => s.stageType === 'official').sort((a, b) => a.sortOrder - b.sortOrder)[0] : null;
      if (timing.replaceOfficialFirst && !previous) throw new Error('Expected existing stage is absent');
      if (previous) await tx.registrationStage.update({ where: { id: previous.id }, data: values });
      else await tx.registrationStage.create({ data: { competitionId: d.id, ...values,
        sortOrder: Math.max(-1, ...original.stages.map(s => s.sortOrder)) + 1 + d.stages.indexOf(timing) } });
      await evidence('registrationStages', values, timing.applicableTo, timing.evidence);
      changes.push({ field: 'registrationStages', before: previous || null, after: values });
    }
    const existingEntries = [...original.entries];
    const checkedIds = new Set();
    for (const e of d.entries) {
      const previous = existingEntries.find(x => e.url ? normUrl(x.url) === normUrl(e.url) : !x.url && x.type === e.type);
      const values = { type: e.type, url: e.url || null, method: e.method, note: e.note, contact: e.contact || null, ...inspection(e, e) };
      const updated = previous ? await tx.signupEntry.update({ where: { id: previous.id }, data: values })
        : await tx.signupEntry.create({ data: { competitionId: d.id, ...values } });
      checkedIds.add(updated.id);
      changes.push({ field: 'signupEntry', before: previous || null, after: { ...values, id: updated.id } });
    }
    // Keep historical/alternative entries, with actual observations instead of fabricated historic logs.
    for (const e of existingEntries.filter(e => !checkedIds.has(e.id))) {
      const note = e.note || `保留原有${e.type}入口；适用届次/地区按关联通知确认。本轮仅核验公开访问，不代表仍可报名。`;
      await tx.signupEntry.update({ where: { id: e.id }, data: { ...inspection(e), note } });
    }
    const final = { ...original, ...data };
    const hosts = await tx.competitionOrganizer.count({ where: { competitionId: d.id } });
    const qual = JSON.parse(data.eligibilityJson || original.eligibilityJson || '{}');
    const limited = Object.entries(scopes).filter(([, scope]) => scope !== 'national').map(([key, scope]) => ({ key, scope }));
    const conflicts = d.index === 44; // Official BIM I-J dates remain contradictory.
    const completeness = computeCompleteness([
      { key: 'name', value: final.name, state: 'explicit' },
      { key: 'organizer', value: hosts ? ['host'] : null, state: hosts ? 'explicit' : 'unmentioned' },
      { key: 'eligibility', value: qual.eligibility || null, state: limited.some(f => f.key === 'eligibility') ? 'to_confirm' : 'explicit' },
      { key: 'signupMethod', value: final.signupMethod, state: limited.some(f => f.key === 'signupMethod') ? 'to_confirm' : 'explicit' },
      { key: 'nearestDeadline', value: final.nearestDeadline?.toISOString() || null, state: final.nearestDeadline ? 'explicit' : 'unmentioned' },
    ], conflicts);
    const scopedCompleteness = limited.length || d.scopeIssues.length || !has(final.description) || !has(final.scheduleNote)
      ? conflicts ? 'conflict' : 'partial' : completeness;
    const types = [...new Set([...d.fields.map(f => f.evidence.sourceType), ...original.sources.map(s => s.type)])];
    const quality = computeCredibility({ sourceTypes: types, completeness: scopedCompleteness, distinctSourceCount: 1, reviewed: true });
    Object.assign(data, { completeness: scopedCompleteness, credibility: quality.level, credibilityScore: quality.score,
      credibilityBasis: quality.basis.map(s => s.replace('已人工审核', '已逐项复核原文（AI辅助）')).join('；') +
        '；完整性与来源可信度分开；具体适用届次、地区和赛项见报名说明；未验证真实提交。' });
    const primaryProbe = final.signupUrl ? probes.get(final.signupUrl) : null;
    data.siteStatus = primaryProbe?.status || 'unverified';
    if (data.nearestDeadline) {
      const stages = await tx.registrationStage.findMany({ where: { competitionId: d.id } });
      const stage = stages.find(s => s.endAt && endOfDayIfNeeded({ at: s.endAt.toISOString(), precision: s.endPrecision }).getTime() === data.nearestDeadline.getTime());
      if (stage) data.registrationStatus = deriveRegistrationStatus({ startAt: { at: stage.startAt?.toISOString() || null, precision: stage.startPrecision },
        endAt: { at: stage.endAt.toISOString(), precision: stage.endPrecision } }, now);
    }
    const reserved = await tx.competition.updateMany({ where: { id: d.id, versionNo: d.expectedVersion, publishStatus: d.publishStatus }, data });
    if (reserved.count !== 1) throw new Error('Version reservation failed');
    const review = { repairId: manifest.repairId, reviewedAt: now.toISOString(), publication: 'unchanged',
      verification: 'AI-assisted-source-review', fields: d.fields.map(f => ({ key: f.key, scope: f.scope, source: f.evidence.url, sha256: f.evidence.sha256 })),
      sourceChecks: d.sourceChecks, entryChecks: [...existingEntries, ...d.entries].map(e => ({ url: e.url, observation: e.url ? probes.get(e.url) : 'notice workflow reviewed; no personal web form' })),
      priorTimeAssessment: d.priorTimeAssessment, priorFollowup: d.priorFollowup, priorWarnings: d.priorWarnings,
      unresolved: d.unresolved, scopedFields: limited, notes: d.notes,
      investigation: '实际重新读取通知及附件；扫描PDF空提取已辨读；历史跳过/限制按原日志保留。此为本轮核验日志，不补造历史报名提交记录。',
    };
    await tx.fieldEvidence.create({ data: { competitionId: d.id, fieldName: 'informationRepairReview', fieldValue: JSON.stringify(review),
      sourceTitle: '2026-11-17 逐项缺陷修复与报名路径核验', extractMethod: 'manual', manuallyCorrected: true,
      confidence: quality.level, fieldState: 'explicit' } });
    await tx.reviewRecord.create({ data: { competitionId: d.id, action: 'comment', reviewer: actorId,
      comment: `【${manifest.repairId}】已复核${d.fields.length}项字段决策、报名流程及公开访问，AI辅助核验。${d.unresolved.join('；')} 详情见informationRepairReview证据记录。保留${d.publishStatus}状态；未执行真实报名。` } });
    await tx.competitionVersion.create({ data: { competitionId: d.id, versionNo: d.expectedVersion + 1, actor: actorId,
      reason: `${manifest.repairId} 竞赛缺陷/占位修复、报名路径与核验日志补录`, changesJson: JSON.stringify(changes) } });
    await tx.outboxEvent.create({ data: { eventType: 'competition.updated', objectType: 'competition', objectId: d.id,
      payloadJson: JSON.stringify({ repairId: manifest.repairId, fields: d.fields.map(f => f.key), publication: 'unchanged' }) } });
    await new AuditService(tx).record({ actorId, action: 'competition.information_repair', objectType: 'competition', objectId: d.id,
      detail: { repairId: manifest.repairId, index: d.index, versionNo: d.expectedVersion + 1, fieldCount: d.fields.length, publication: 'unchanged' } });
    return { id: d.id, index: d.index, versionNo: d.expectedVersion + 1, publishStatus: d.publishStatus,
      completeness: scopedCompleteness, credibility: quality.level, fieldCount: d.fields.length, unresolved: d.unresolved };
  }, { maxWait: 15000, timeout: 30000 });
}

async function main() {
  const prepared = await preflight(); console.log(JSON.stringify(prepared));
  if (!apply) return;
  if (fs.existsSync(resultFile)) throw new Error('Result exists; read actual DB before recovery, do not blindly retry');
  const result = { repairId: manifest.repairId, ...prepared, startedAt: now.toISOString(), rows: [] }; save(result);
  for (const d of manifest.rows) {
    const item = { index: d.index, id: d.id, status: 'running' }; result.rows.push(item); save(result);
    try { Object.assign(item, await repair(d), { status: 'completed' }); }
    catch (error) { item.status = 'failed'; item.error = error.message; save(result); throw error; }
    save(result); console.log(JSON.stringify({ index: d.index, status: item.status, versionNo: item.versionNo }));
  }
  result.finishedAt = new Date().toISOString(); save(result);
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
