// Local, read-only review aid. Never guesses SF provenance from prose.
// Input: exported historical Cosmos records and an explicitly reviewed decision
// map {"<userId>/<id>":"sf"|"non_sf"}. Output goes to stdout, no database writes.
const fs=require('node:fs'),crypto=require('node:crypto');
function prepare(records,decisions){
 const index={},missing=[];
 for(const record of records){
  if(record.role==='user'||record.historyAccess)continue;
  if(!['CHAT_MESSAGE','USER_CANVAS','CHAT_CITATION'].includes(record.type))continue;
  const key=`${record.userId}/${record.id}`,origin=decisions[key];
  if(!record.id||!record.userId||!['sf','non_sf'].includes(origin)){missing.push(key);continue;}
  const content=typeof record.content==='string'?record.content:JSON.stringify(record.content);
  index[key]={origin,thread:record.threadId??'',hash:crypto.createHash('sha256').update(content).digest('hex')};
 }
 if(missing.length)throw Error(`Review required for ${missing.length} historical records; no usable index emitted`);
 return index;
}
module.exports={prepare};
if(require.main===module){
 try{
  const [recordsPath,decisionsPath]=process.argv.slice(2);
  if(!recordsPath||!decisionsPath)throw Error('Usage: node prepare-salesforce-legacy-index.cjs export.json reviewed-decisions.json');
  process.stdout.write(JSON.stringify(prepare(JSON.parse(fs.readFileSync(recordsPath,'utf8')),JSON.parse(fs.readFileSync(decisionsPath,'utf8'))),null,2)+'\n');
 }catch(error){process.stderr.write(error.message+'\n');process.exitCode=1;}
}
