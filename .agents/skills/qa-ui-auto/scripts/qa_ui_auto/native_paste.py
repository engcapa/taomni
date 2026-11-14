"""Deliver one real OS Paste chord to a focused QA editor; no synthetic ClipboardEvent."""
from __future__ import annotations

import json
from pathlib import Path
import platform
import subprocess

from .steps import StepError

MAC = r'''
ObjC.import('AppKit');
const env = $.NSProcessInfo.processInfo.environment;
const exe = ObjC.unwrap(env.objectForKey('QA_PASTE_APPLICATION'));
const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
const pids = [];
for (let i=0;i<apps.count;i++) { const app=apps.objectAtIndex(i); try { if (ObjC.unwrap(app.executableURL.path) === exe) pids.push(Number(app.processIdentifier)); } catch (_) {} }
if (pids.length !== 1) throw new Error('No unique QA executable process');
const events=Application('System Events');
const app=events.processes.whose({unixId:pids[0]})[0];
app.frontmost=true;
if (!app.frontmost()) throw new Error('QA application did not become frontmost');
events.keystroke('v',{using:['command down']});
JSON.stringify({pid:pids[0],transport:'macOS OS Cmd+V'});
'''

WIN = r'''
$ErrorActionPreference='Stop';
Add-Type @"
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
public static class QaPaste {
 [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);
 [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hwnd);
 [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd,int cmd);
 [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,IntPtr processId);
 [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] static extern bool AttachThreadInput(uint attach,uint attachTo,bool fAttach);
 [DllImport("user32.dll")] static extern void keybd_event(byte key,byte scan,uint flags,UIntPtr extra);
 public static long Run(int pid) {
  using(var process=Process.GetProcessById(pid)) {
   var hwnd=process.MainWindowHandle;
   if(hwnd==IntPtr.Zero) throw new Exception("QA window handle missing");
   if(IsIconic(hwnd)) ShowWindow(hwnd,9);
   var fg=GetForegroundWindow();
   if(fg!=hwnd) {
    if(!SetForegroundWindow(hwnd) && fg!=IntPtr.Zero) {
     uint current=GetCurrentThreadId();
     uint owner=GetWindowThreadProcessId(fg,IntPtr.Zero);
     if(owner!=0 && owner!=current && AttachThreadInput(current,owner,true)) {
      try { SetForegroundWindow(hwnd); }
      finally { AttachThreadInput(current,owner,false); }
     }
    }
    BringWindowToTop(hwnd);
    System.Threading.Thread.Sleep(50);
   }
   if(GetForegroundWindow()!=hwnd) throw new Exception("QA window not foreground");
   keybd_event(0x11,0,0,UIntPtr.Zero);
   try { keybd_event(0x56,0,0,UIntPtr.Zero); keybd_event(0x56,0,2,UIntPtr.Zero); }
   finally { keybd_event(0x11,0,2,UIntPtr.Zero); }
   return hwnd.ToInt64();
  }
 }
}
"@;
$application=[IO.Path]::GetFullPath($env:QA_PASTE_APPLICATION);
$owners=@(Get-Process | Where-Object { try { $_.Path -eq $application } catch { $false } });
if($owners.Count -ne 1){throw 'No unique QA executable process'};
$window=[QaPaste]::Run($owners[0].Id);
@{pid=$owners[0].Id;window=$window;transport='Windows OS Ctrl+V'} | ConvertTo-Json -Compress
'''


def run(ctx, args):
    if not isinstance(args, dict) or set(args) != {"selector"} or not isinstance(args["selector"], str) or not args["selector"]:
        raise StepError("native_paste: expected one focused editor selector")
    if getattr(ctx, "dry_run", False):
        return "dry-run; no OS Paste"
    selector = args["selector"]
    focused = ctx.session.execute("const el=document.querySelector(" + json.dumps(selector) + "); return !!el && (el===document.activeElement || el.contains(document.activeElement));")
    if focused is not True:
        raise StepError("native_paste: target does not own focus")
    observation = {"selector": selector, "syntheticClipboardEvent": False, "passed": False}
    try:
        system = platform.system()
        if system == "Linux":
            from . import wayland
            if wayland.active():
                window = wayland.command("activate", application=str(Path(ctx.session.application).resolve()))
                wayland.command("keys", chords=[[0xffe3, ord("v")]])
                observation.update(transport="Mutter OS Ctrl+V", window=window)
            else:
                from .native_steps import _activate_x11_application, _inject_x11_keys
                window, identity = _activate_x11_application(Path(ctx.session.application))
                _inject_x11_keys(["Control+v"])
                observation.update(transport="X11 OS Ctrl+V", window=window, identity=identity)
        else:
            import os
            env = {**os.environ, "QA_PASTE_APPLICATION": str(Path(ctx.session.application).resolve())}
            if system == "Darwin":
                argv = ["osascript", "-l", "JavaScript", "-e", MAC]
            elif system == "Windows":
                argv = ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-Command", WIN]
            else:
                raise StepError("native_paste: unsupported OS")
            result = subprocess.run(argv, env=env, text=True, capture_output=True, timeout=20)
            if result.returncode:
                raise StepError("native_paste: " + (result.stderr or result.stdout).strip())
            observation.update(json.loads(result.stdout))
        observation["passed"] = True
        return "One native OS paste chord delivered; case asserts the actual editor and disk results"
    except Exception as error:
        observation["error"] = str(error)
        raise
    finally:
        with (ctx.case_dir / "native-paste.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation) + "\n")
