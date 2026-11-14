/** Explicit one-shot staging migration. JSON files remain authoritative.
 * Usage in a configured app container:
 *   node --import tsx server/pgStateMigrator.ts --dry-run
 *   node --import tsx server/pgStateMigrator.ts --apply
 */
import { identityPool, initializeIdentity } from './pgIdentity';
import { verifyPersonalStateStaging } from './pgPersonalStateVerifier';
import { DEFAULT_PERSONAL_STATE_STAGE_KEY, personalStateSnapshotDigest,
  preparePersonalStateRows, readJsonSnapshot, readPersonalStateSchema,
  stagePersonalStateToPostgres } from './pgPersonalState';

async function main() {
  const args=process.argv.slice(2);
  if(args.length!==1 || !['--dry-run','--apply','--verify'].includes(args[0]))
    throw new Error('Specify exactly --dry-run or --apply or --verify');
  const dry=args[0]==='--dry-run';
  const verify=args[0]==='--verify';
  const snapshot=readJsonSnapshot();
  // --verify must be truly read-only, including schema setup. Applying or
  // planning the first migration still initializes existing identity tables.
  if (!verify) await initializeIdentity();
  const connection=await identityPool().connect();
  try {
    if (verify) {
      const result=await verifyPersonalStateStaging(connection,snapshot);
      // Only aggregate counts and fingerprints, never individual user IDs,
      // coins, trading history, chat identities or private JSON payloads.
      console.log(JSON.stringify({mode:'verify-read-only',...result,
        changesApplied:false,jsonStillAuthoritative:true,liveCutover:false},null,2));
      if (!result.consistent) process.exitCode=2;
      return;
    }
    if(dry) {
      const r=await connection.query('SELECT id FROM auth_users');
      const prepared=preparePersonalStateRows(snapshot,
        new Set<string>(r.rows.map((u:{id:string})=>u.id)));
      let previousHash: string | null = null;
      try {
        const previous=await connection.query(
          'SELECT snapshot_sha256 FROM h00k_personal_state_staging_runs WHERE stage_key=$1',
          [DEFAULT_PERSONAL_STATE_STAGE_KEY]);
        previousHash=previous.rows[0]?.snapshot_sha256 ?? null;
      } catch(error) {
        // A first-time dry-run must also work before 002_personal_state.sql
        // creates the staging tables; other PostgreSQL errors still fail.
        if ((error as {code?:string}).code !== '42P01') throw error;
      }
      const snapshotSha256=personalStateSnapshotDigest(snapshot);
      console.log(JSON.stringify({mode:'dry-run',surveillance:prepared.surveillance.length,
        alerts:prepared.alerts.length,history:prepared.history.length,
        skipped:prepared.skipped,stageKey:DEFAULT_PERSONAL_STATE_STAGE_KEY,
        snapshotSha256,stagedSnapshotMatches:previousHash===null ? null :
          previousHash===snapshotSha256,
        changesApplied:false},null,2));
      return;
    }
    const count=await stagePersonalStateToPostgres(connection,snapshot,readPersonalStateSchema());
    console.log(JSON.stringify({mode:'staged-to-postgresql',...count,
      jsonStillAuthoritative:true,liveCutover:false},null,2));
  } finally { connection.release(); await identityPool().end(); }
}
main().catch(error=>{console.error('[Personal state migration]',error.message);process.exitCode=1;});
