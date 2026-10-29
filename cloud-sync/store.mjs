import { randomUUID } from 'node:crypto';
export class PgStore {
 constructor(pool){this.pool=pool;}
 async init(){await this.pool.query(`CREATE TABLE IF NOT EXISTS sync_vaults(uid text PRIMARY KEY,revision uuid NOT NULL,snapshot jsonb,updated_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS sync_sessions(hash text PRIMARY KEY,uid text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),expires_at timestamptz NOT NULL);
 CREATE INDEX IF NOT EXISTS sync_sessions_uid ON sync_sessions(uid);
 CREATE INDEX IF NOT EXISTS sync_sessions_expiry ON sync_sessions(expires_at);`);}
 async health(){await this.pool.query('SELECT 1');}
 async session(hash,uid){const c=await this.pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[uid]);await c.query("DELETE FROM sync_sessions WHERE expires_at<now()");await c.query("INSERT INTO sync_sessions(hash,uid,expires_at) VALUES($1,$2,now()+interval '30 days')",[hash,uid]);await c.query('DELETE FROM sync_sessions WHERE uid=$1 AND hash NOT IN (SELECT hash FROM sync_sessions WHERE uid=$1 ORDER BY created_at DESC LIMIT 10)',[uid]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async authenticate(hash){return(await this.pool.query('SELECT uid FROM sync_sessions WHERE hash=$1 AND expires_at>now()',[hash])).rows[0]?.uid;}
 async read(uid){return(await this.pool.query('SELECT revision,snapshot FROM sync_vaults WHERE uid=$1',[uid])).rows[0];}
 async write(uid,revision,create,snapshot,tokenHash){
  const c=await this.pool.connect();try {
   await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[uid]);
   if(tokenHash && !(await c.query('SELECT 1 FROM sync_sessions WHERE hash=$1 AND uid=$2 AND expires_at>now()',[tokenHash,uid])).rowCount){await c.query('ROLLBACK');return null;}
   if(create){await c.query('SELECT pg_advisory_xact_lock(895203001)');const n=Number((await c.query('SELECT COUNT(*) AS n FROM sync_vaults')).rows[0].n);if(n>=200){const error=new Error('capacity');error.status=503;throw error;}}
   const next=randomUUID(),data=JSON.stringify(snapshot);
   const result=create?await c.query('INSERT INTO sync_vaults(uid,revision,snapshot) VALUES($1,$2,$3) ON CONFLICT(uid) DO NOTHING RETURNING revision',[uid,next,data]):await c.query('UPDATE sync_vaults SET revision=$3,snapshot=$4,updated_at=now() WHERE uid=$1 AND revision=$2 RETURNING revision',[uid,revision,next,data]);
   await c.query('COMMIT');return result.rows[0]?.revision;
  }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
 }
 async revoke(hash){await this.pool.query('DELETE FROM sync_sessions WHERE hash=$1',[hash]);}
 async remove(uid){const c=await this.pool.connect();try{await c.query('BEGIN');await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[uid]);await c.query('DELETE FROM sync_sessions WHERE uid=$1',[uid]);await c.query('DELETE FROM sync_vaults WHERE uid=$1',[uid]);await c.query('COMMIT');}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}}
 async cleanup(){await this.pool.query("DELETE FROM sync_sessions WHERE expires_at<now()");}
}
