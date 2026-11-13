/** Explicit one-shot staging migration. JSON files remain authoritative.
 * Usage in a configured app container:
 *   node --import tsx server/pgStateMigrator.ts --dry-run
 *   node --import tsx server/pgStateMigrator.ts --apply
 */
import { identityPool, initializeIdentity } from './pgIdentity';
import { preparePersonalStateRows, readJsonSnapshot,
  readPersonalStateSchema, stagePersonalStateToPostgres } from './pgPersonalState';

async function main() {
  const args=process.argv.slice(2);
  if(args.length!==1 || !['--dry-run','--apply'].includes(args[0]))
    throw new Error('Specify exactly --dry-run or --apply');
  const dry=args[0]==='--dry-run';
  const snapshot=readJsonSnapshot();
  await initializeIdentity(); // Existing credentials, not a second PostgreSQL instance.
  const connection=await identityPool().connect();
  try {
    if(dry) {
      const r=await connection.query('SELECT id FROM auth_users');
      const prepared=preparePersonalStateRows(snapshot,
        new Set<string>(r.rows.map((u:{id:string})=>u.id)));
      console.log(JSON.stringify({mode:'dry-run',surveillance:prepared.surveillance.length,
        alerts:prepared.alerts.length,history:prepared.history.length,
        skipped:prepared.skipped,changesApplied:false},null,2));
      return;
    }
    const count=await stagePersonalStateToPostgres(connection,snapshot,readPersonalStateSchema());
    console.log(JSON.stringify({mode:'staged-to-postgresql',...count,
      jsonStillAuthoritative:true,liveCutover:false},null,2));
  } finally { connection.release(); await identityPool().end(); }
}
main().catch(error=>{console.error('[Personal state migration]',error.message);process.exitCode=1;});
