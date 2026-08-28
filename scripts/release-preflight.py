#!/usr/bin/env python3
"""Read-only production/candidate checks. Never checkout/reset/restart, and never print env values."""
import argparse, pathlib, subprocess, json, hashlib
BASELINE='95426bb0cb71e3c8523aebe3ee477cc89fae7ebd'
def git(root,*args):return subprocess.check_output(['git','-C',str(root),*args],text=True).strip()
def envkeys(file):
 if not file.exists():return {}
 result={}
 for line in file.read_text().splitlines():
  if '=' in line and not line.lstrip().startswith('#'):
   k,v=line.split('=',1);result[k.strip()]=v.strip().strip('\"\x27')
 return result

def inspect(candidate,prod):
 blockers=[]; candidate=pathlib.Path(candidate).resolve();prod=pathlib.Path(prod).resolve()
 if candidate==prod:raise ValueError('Candidate and production must be separate checkouts')
 if prod.name!='Shannon-prod' or candidate.name!='Shannon-dev':raise ValueError('Unexpected checkout names')
 candidate_head=git(candidate,'rev-parse','HEAD');prod_head=git(prod,'rev-parse','HEAD')
 if git(candidate,'status','--porcelain'):blockers.append('candidate_worktree_dirty')
 if git(prod,'status','--porcelain'):blockers.append('production_worktree_dirty')
 if subprocess.run(['git','-C',str(candidate),'merge-base','--is-ancestor',BASELINE,candidate_head],capture_output=True).returncode: blockers.append('production_preservation_not_in_candidate')
 env=envkeys(prod/'backend/.env');front=envkeys(prod/'frontend/.env')
 for key in ['FIREBASE_PROJECT_ID','WEB_ALLOWED_ORIGINS','MINEBOT_API_TOKEN']:
  if not env.get(key):blockers.append('production_missing_'+key.lower())
 if env.get('FIREBASE_PROJECT_ID') != front.get('VITE_FIREBASE_PROJECT_ID'):blockers.append('production_firebase_project_mismatch')
 adc=env.get('GOOGLE_APPLICATION_CREDENTIALS')
 if not adc or not pathlib.Path(adc).is_file():blockers.append('production_server_credential_not_verified')
 # Required evidence is deliberately not inferred from a green unit-test run.
 blockers += ['reviewed_uid_migration_and_login_evidence_required','live_channel_and_spend_limits_required',
              'quiesced_database_backup_required_at_cutover','native_artifact_and_full_build_validation_required',
              'functional_restrictions_and_rollback_review_required']
 return {'ready':not blockers,'candidateHead':candidate_head,'productionHead':prod_head,'preservedBaseline':BASELINE,'blockers':blockers}
if __name__=='__main__':
 parser=argparse.ArgumentParser();parser.add_argument('--candidate',required=True);parser.add_argument('--production',required=True);a=parser.parse_args()
 try:result=inspect(a.candidate,a.production);print(json.dumps(result,indent=2));raise SystemExit(0 if result['ready'] else 2)
 except (ValueError,subprocess.CalledProcessError):print(json.dumps({'ready':False,'error':'INVALID_REPOSITORY'}));raise SystemExit(2)
