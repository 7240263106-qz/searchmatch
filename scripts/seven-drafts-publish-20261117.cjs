/* Publish the remaining seven draft competitions from the 71-item school catalog.
 * Flow per record: submit-review -> publish (via HTTPS API, actor u-demo).
 * BIM I-J deadline conflict (2027-01-29 vs 01-30 same page) is annotated in the
 * review comment, not silently resolved.
 * Run with --dry-run to preview. Requires ~/.ssh/competition-sj-access.json. */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');

const ACCESS_FILE = path.join(process.env.USERPROFILE || process.env.HOME, '.ssh', 'competition-sj-access.json');
const OUT_DIR = path.resolve(__dirname, '../artifacts/seven-drafts-20261117');
const DRY_RUN = process.argv.includes('--dry-run');

const TARGETS = [
  {
    id: 'cmweeb3lo003kqbhgqi3xnaws',
    name: '全国大学生结构设计竞赛',
    comment: '人工审核通过：第十九届(2026)已于10月16—18日在内蒙古科技大学举办(承办校赛后报道确认)；校赛资格、学校统一报名路径及官方来源均已补录留证。下一届通知未发布，时间说明中已明确不套届。',
  },
  {
    id: 'cmweeb3nj0054qbhgyx2cwsm6',
    name: '中国大学生工程实践与创新能力大赛',
    comment: '人工审核通过：2027第十届预通知(中国海洋大学公开转发)已补录赛道、资格、官网报名入口及省级报送节点；全国决赛仅到月份精度，说明中已标明，未虚构日期。',
  },
  {
    id: 'cmweeb3o0005iqbhg5k2zi7k3',
    name: '全国大学生物流设计大赛',
    comment: '人工审核通过：第九届(2025)中物联签发原件(高校存档PDF)已补录报名、赛程、资格与官网入口；新届未发布，说明中明确为历史资料不平移。',
  },
  {
    id: 'cmweeb3xc00egqbhgdz9ol2tn',
    name: '睿抗机器人开发者大赛（RAICOM）',
    comment: '人工审核通过：2026届四赛道、省级选拔与全国决赛阶段(月份精度)、学校统一组织路径及官网入口已补录；全国报名仅到月份，已注明。',
  },
  {
    id: 'cmweeb3z600geqbhgky6f5lyp',
    name: '全国高校BIM毕业设计创新大赛',
    comment: '人工审核通过(保留冲突标注)：第十三届章程官网已补录A—H报名截止2026-11-30 16:00；I—J模块同页出现2027-01-29 16:00与01-30两种表述，冲突已在说明与证据中保留，未虚构精确截止，发布供使用时以官网后续通知为准。',
  },
  {
    id: 'cmweeb40o00hyqbhgn58ikcxz',
    name: '中国好创意暨全国数字艺术设计大赛',
    comment: '人工审核通过：第21届官方PDF已补录常规赛报名投稿2026-10-20至2027-05-31 17:00、校赛/省赛/国赛节点、资格与官网入口；专项赛道单独截止已注明。',
  },
  {
    id: 'cmweeb41500icqbhgy7804l2c',
    name: '中国机器人及人工智能大赛',
    comment: '人工审核通过：第二十八届(2026)全国决赛线上通知及校选通知已补录；线上决赛7月10—23日仅适用通知列出赛项，学校统一报名路径明确，范围边界已注明。',
  },
  {
    id: 'cmweeb4as00raqbhgwdgyvynj',
    name: '中国校园戏剧节比赛',
    comment: '人工审核通过：第10届中国剧协征集通知已补录；省级剧协2026-07-31前汇总报送、线下征集路径及资格已明确；实际展演日期未确认已在说明中保留。',
  },
];

function request(access, method, apiPath, body) {
  const url = new URL(access.url.replace(/\/$/, '') + '/api/v1' + apiPath);
  const auth = Buffer.from(access.username + ':' + access.password).toString('base64');
  const payload = body ? JSON.stringify(body) : null;
  return new Promise((resolve, reject) => {
    const req = https.request({
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: {
        authorization: 'Basic ' + auth,
        ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 45000,
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch { /* keep raw */ }
        resolve({ status: res.statusCode, body: parsed ?? text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function main() {
  const access = JSON.parse(fs.readFileSync(ACCESS_FILE, 'utf8'));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  for (const target of TARGETS) {
    const detail = await request(access, 'GET', '/competitions/' + target.id);
    if (detail.status !== 200) throw new Error(`GET ${target.name} -> ${detail.status}`);
    const before = detail.body.data ?? detail.body;
    if (before.name !== target.name) throw new Error(`名称漂移: ${before.name} != ${target.name}`);
    const entry = { id: target.id, name: target.name, beforeStatus: before.publishStatus, beforeVersion: before.versionNo, steps: [] };
    if (DRY_RUN) {
      entry.steps.push({ step: 'dry-run', status: before.publishStatus });
      results.push(entry);
      console.log(`[dry-run] ${target.name}: ${before.publishStatus} v${before.versionNo}`);
      continue;
    }
    if (before.publishStatus === 'draft') {
      const submitted = await request(access, 'POST', `/competitions/${target.id}/submit-review`, { comment: '七项草稿补录完成，提交审核' });
      if (submitted.status >= 400) throw new Error(`submit-review ${target.name} -> ${submitted.status} ${JSON.stringify(submitted.body)}`);
      entry.steps.push({ step: 'submit-review', status: 200, result: submitted.body.data ?? submitted.body });
    } else if (before.publishStatus !== 'pending_review' && before.publishStatus !== 'published') {
      throw new Error(`非预期状态 ${target.name}: ${before.publishStatus}`);
    }
    if (before.publishStatus !== 'published') {
      const published = await request(access, 'POST', `/competitions/${target.id}/publish`, { comment: target.comment });
      if (published.status !== 200 && published.status !== 201) throw new Error(`publish ${target.name} -> ${published.status} ${JSON.stringify(published.body)}`);
      entry.steps.push({ step: 'publish', status: published.status, result: published.body.data ?? published.body });
    }
    const after = await request(access, 'GET', '/competitions/' + target.id);
    const afterData = after.body.data ?? after.body;
    entry.afterStatus = afterData.publishStatus;
    entry.afterVersion = afterData.versionNo;
    entry.credibility = afterData.credibility;
    entry.credibilityScore = afterData.credibilityScore;
    if (entry.afterStatus !== 'published') throw new Error(`发布失败 ${target.name}: ${entry.afterStatus}`);
    results.push(entry);
    console.log(`${target.name}: ${entry.beforeStatus} v${entry.beforeVersion} -> published v${entry.afterVersion} (${entry.credibility}/${entry.credibilityScore})`);
  }
  fs.writeFileSync(path.join(OUT_DIR, 'publish-execution.json'), JSON.stringify({ at: new Date().toISOString(), dryRun: DRY_RUN, results }, null, 2));
  console.log(JSON.stringify({ published: results.filter((r) => r.afterStatus === 'published').length, total: TARGETS.length }));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
