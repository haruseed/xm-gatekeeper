// One-time operational policy change. Run only after the shared-deadline code is healthy.
import { writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { loadConfig, secureRng } from '@guard/core';
import { openDatabase, Store } from '@guard/database';
const config=loadConfig(process.env);
const backup=process.argv[2];
if(!backup||!isAbsolute(backup))throw Error('Provide an absolute, new group-settings backup filename');
const db=openDatabase(config.databasePath);
const store=new Store(db,secureRng,Boolean(config.cap));
try {
 const result=db.transaction(()=>{
  const groups=store.listGroups();
  writeFileSync(backup,JSON.stringify(groups.map(g=>({chat_id:g.chat_id,settings_json:g.settings_json,settings_version:g.settings_version,updated_at:g.updated_at})),null,2),{flag:'wx',mode:0o600});
  const now=Date.now();
  for(const group of groups)store.updateSettings(group.chat_id,{...store.settingsOf(group),requestLifetimeMin:1,challengeTimeoutSec:60},0,'verificationStageTimes',now);
  // Existing checks keep their original start (or explicit administrator-granted restart).
  const clipped=db.query(`UPDATE join_requests SET deadline_at=MIN(deadline_at,
    MAX(request_date,COALESCE((SELECT passed_at FROM cap_sessions WHERE request_id=join_requests.id),request_date),COALESCE((SELECT MAX(created_at) FROM audit_events WHERE correlation_id=join_requests.id AND action='retry_granted'),request_date))+60000)
    WHERE state IN ('pending','challenging')`).run().changes;
  db.query(`UPDATE sessions SET expires_at=MIN(expires_at,(SELECT deadline_at FROM join_requests WHERE id=sessions.request_id))
    WHERE state IN ('preparing','active')`).run();
  db.query(`UPDATE callback_tokens SET expires_at=MIN(expires_at,(SELECT expires_at FROM sessions WHERE id=callback_tokens.session_id))
    WHERE session_id IN (SELECT id FROM sessions WHERE state IN ('preparing','active'))`).run();
  db.query(`UPDATE cap_sessions SET expires_at=MIN(expires_at,(SELECT deadline_at FROM join_requests WHERE id=cap_sessions.request_id))
    WHERE passed_at IS NULL`).run();
  return {groups:groups.length,existingChecksConsidered:clipped};
 }).immediate();
 console.log(JSON.stringify({...result,capSeconds:60,pictureSeconds:60,settingsBackup:backup}));
} finally {db.close();}
