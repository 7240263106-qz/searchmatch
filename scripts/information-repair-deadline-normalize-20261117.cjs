/* Normalize day-precision parent deadlines to their matching stage's raw midnight. */
const fs=require('node:fs'),path=require('node:path');
const root=process.env.REPAIR_API_ROOT||path.resolve(__dirname,'../apps/api');
require(path.join(root,'node_modules/reflect-metadata'));
const {PrismaClient}=require(path.join(root,'node_modules/@prisma/client'));
const {AuditService}=require(path.join(root,'dist/platform/audit.module'));
const {parseDateTime}=require(path.join(root,'dist/domain/time'));
const directory=process.env.REPAIR_DIR||path.resolve(__dirname,'../artifacts/competition-information-repair-20261117');
const manifest=JSON.parse(fs.readFileSync(path.join(directory,'repair-manifest.json'),'utf8'));
const prisma=new PrismaClient(),actor='system:information-repair-ai-assisted';
const output=path.join(directory,process.env.REPAIR_DATE_RESULT||'deadline-normalization-execution.json');
async function main(){
 const prepared=[];
 for(const d of manifest.rows){
  const row=await prisma.competition.findUniqueOrThrow({where:{id:d.id},include:{stages:true}});
  if(!row.nearestDeadline)continue;
  const stages=row.stages.filter(s=>s.endAt&&s.endPrecision==='day'&&s.endRawText);
  const parsed=stages.map(s=>({stage:s,at:new Date(parseDateTime(s.endRawText).at)})).filter(x=>Math.abs(x.at-row.nearestDeadline)===86399000);
  if(parsed.length===1)prepared.push({d,row,stage:parsed[0].stage,value:parsed[0].at});
  else if(parsed.length>1)throw new Error('Ambiguous day stage: '+d.index);
 }
 console.log(JSON.stringify({prepared:prepared.length,indices:prepared.map(p=>p.d.index),mode:process.argv.includes('--apply')?'apply':'read_only'}));
 if(!process.argv.includes('--apply'))return;
 if(fs.existsSync(output))throw new Error('Result exists; inspect before recovery');
 const result={repairId:'FIX-20261117-02.3',rows:[]};const save=()=>fs.writeFileSync(output,JSON.stringify(result,null,2));save();
 for(const {d,row,stage,value} of prepared){
  const item={index:d.index,id:d.id,status:'running'};result.rows.push(item);save();
  try{await prisma.$transaction(async tx=>{
   const before=await tx.competition.findUniqueOrThrow({where:{id:d.id}});
   if(before.versionNo!==row.versionNo||before.nearestDeadline.getTime()!==row.nearestDeadline.getTime()||before.publishStatus!==d.publishStatus)throw new Error('Concurrent edit');
   const updated=await tx.competition.updateMany({where:{id:d.id,versionNo:row.versionNo,publishStatus:d.publishStatus},data:{nearestDeadline:value,versionNo:{increment:1}}});
   if(updated.count!==1)throw new Error('Version reservation failed');
   await tx.competitionVersion.create({data:{competitionId:d.id,versionNo:row.versionNo+1,actor,reason:'FIX-20261117-02.3 日精度截止与阶段零点统一',changesJson:JSON.stringify([{field:'nearestDeadline',before:before.nearestDeadline,after:value,stage:stage.name,rawText:stage.endRawText,precision:'day'}])}});
   await tx.reviewRecord.create({data:{competitionId:d.id,action:'comment',reviewer:actor,comment:'【FIX-20261117-02.3】验收发现父截止为日末23:59:59而匹配阶段为零点；统一存阶段日期的零点，日精度及endOfDay比较语义保持不变，不改变实际截止日、原文或发布状态。'}});
   await tx.outboxEvent.create({data:{eventType:'competition.updated',objectType:'competition',objectId:d.id,payloadJson:JSON.stringify({repairId:'FIX-20261117-02.3',field:'nearestDeadline',publication:'unchanged'})}});
   await new AuditService(tx).record({actorId:actor,action:'competition.information_repair_date_normalization',objectType:'competition',objectId:d.id,detail:{repairId:'FIX-20261117-02.3',rawText:stage.endRawText,versionNo:row.versionNo+1}});
  });item.status='completed';item.versionNo=row.versionNo+1;}catch(e){item.status='failed';item.error=e.message;save();throw e;}save();
 }
 result.finishedAt=new Date().toISOString();save();console.log(JSON.stringify({completed:result.rows.length}));
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>prisma.$disconnect());
