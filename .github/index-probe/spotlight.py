import json, pathlib,subprocess,time,os
report = pathlib.Path("probe-results");report.mkdir(exist_ok=True)
path = pathlib.Path("/System/Applications/Calculator.app")
records=[]
cases = [('exact','kMDItemFSName == "Calculator.app"'),('exact-postfix','kMDItemFSName == "calculator.app"c'),('exact-bracket','kMDItemFSName ==[c] "calculator.app"'),('glob','kMDItemFSName == "*Calculator.app*"'),('glob-postfix','kMDItemFSName == "*calculator.app*"c'),('glob-bracket','kMDItemFSName ==[c] "*calculator.app*"'),('subseq','kMDItemFSName == "*c*l*c*l*t*r*.*a*p*p*"c'),('subseq-bracket','kMDItemFSName ==[c] "*c*l*c*l*t*r*.*a*p*p*"'),('name','Calculator.app')]
for scope in [[],['-onlyin','/System/Applications']]:
 for tag,query in cases:
  command=['/usr/bin/mdfind','-0',*scope, *(['-name'] if tag=='name' else []),query]
  t=time.monotonic();p=subprocess.run(command,capture_output=True,timeout=12);paths=[v.decode(errors='replace') for v in p.stdout.split(b'\x00') if v];r=dict(tag=tag,scope=scope,query=query,returned=p.returncode,ms=round(1000*(time.monotonic()-t)),size=len(p.stdout),count=len(paths),hit=str(path) in paths,sample=paths[:1],stderr=p.stderr.decode(errors='replace')[:250]);records.append(r);print(r,flush=True)
(report/'spotlight.json').write_text(json.dumps({'queries':records,'path':str(path),'lstat':str(path.lstat()),'mounts':subprocess.check_output(['/sbin/mount'],text=True)},indent=2))
assert any(r['tag']=='exact' and r['hit'] for r in records)
assert any(r['tag']=='glob-postfix' and r['hit'] and not r['scope'] for r in records)
