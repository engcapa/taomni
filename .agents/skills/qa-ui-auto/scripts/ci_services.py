"""Provision disposable per-job SSH and MySQL services and emit runner config."""
from __future__ import annotations
import json, os, platform, secrets, socket, subprocess, time
from pathlib import Path

class Services:
    def __init__(self, root, capabilities, config): self.root=Path(root); self.cap=set(capabilities); self.config=config; self.resources=[]
    def __enter__(self):
        self.root.mkdir(parents=True,exist_ok=True)
        if platform.system() != 'Linux':
            raise RuntimeError('CI service provider currently requires Linux hosted service installation; Windows/macOS native service adapters are not yet available')
        if not shutil_which('docker'): raise RuntimeError('docker is required for CI SSH/MySQL fixtures')
        token=secrets.token_hex(6); env={}
        if 'ssh' in self.cap:
            pwd=secrets.token_urlsafe(18); name=f'qa-ssh-{token}'
            run(['docker','run','-d','--rm','--name',name,'-e',f'USER_NAME=testuser','-e',f'USER_PASSWORD={pwd}','-e','PASSWORD_ACCESS=true','-p','0:2222','linuxserver/openssh-server:latest'])
            port=published(name,2222); wait_port('127.0.0.1',port)
            env.update(ssh={'host':'127.0.0.1','port':port,'user':'testuser','password':pwd},sftp={'host':'127.0.0.1','port':port,'user':'testuser','password':pwd,'remote_test_dir':'/tmp/qa-ui-auto'})
            self.resources.append(name)
        if 'mysql' in self.cap:
            pwd=secrets.token_urlsafe(18); rootpwd=secrets.token_urlsafe(18); name=f'qa-mysql-{token}'
            run(['docker','run','-d','--rm','--name',name,'-e',f'MYSQL_ROOT_PASSWORD={rootpwd}','-e','MYSQL_DATABASE=test','-e','MYSQL_USER=test','-e',f'MYSQL_PASSWORD={pwd}','-p','0:3306','mysql:8.4'])
            port=published(name,3306); wait_port('127.0.0.1',port,120)
            env.update(database={'host':'127.0.0.1','port':port,'user':'test','password':pwd,'database':'test'},mysql={'host':'127.0.0.1','port':port,'user':'test','password':pwd,'database':'test'})
            self.resources.append(name)
        self.config.update(env); (self.root/'lease.json').write_text(json.dumps({'capabilities':sorted(self.cap),'resources':self.resources,'environment':{k:v for k,v in env.items() if k not in ('password',)}},default=str),encoding='utf-8'); return self
    def __exit__(self,*exc):
        for name in reversed(self.resources): subprocess.run(['docker','rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
def run(cmd): subprocess.run(cmd,check=True,stdout=subprocess.DEVNULL)
def shutil_which(x):
 import shutil; return shutil.which(x)
def published(name,port):
 out=subprocess.check_output(['docker','port',name,str(port)],text=True).strip(); return int(out.rsplit(':',1)[1])
def wait_port(host,port,timeout=60):
 end=time.time()+timeout
 while time.time()<end:
  try:
   with socket.create_connection((host,port),2): return
  except OSError: time.sleep(1)
 raise RuntimeError(f'service port {host}:{port} not ready')
def main():
 caps=json.loads(os.environ.get('QA_CAPABILITIES','[]')); cfg={};
 with Services(Path('qa-ui-auto-report/services'),caps,cfg): print(json.dumps(cfg))
if __name__=='__main__': main()
