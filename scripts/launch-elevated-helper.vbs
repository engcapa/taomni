' VBScript launcher to guarantee Windows 11 UAC elevation dialog
Set WshShell = CreateObject("WScript.Shell")
Set objArgs = WScript.Arguments

If objArgs.Count < 4 Then
    WScript.Echo "Usage: cscript launch-elevated-helper.vbs <exe> <token> <port> <windivert_dir> <ready_file>"
    WScript.Quit 1
End If

exePath = objArgs(0)
token = objArgs(1)
port = objArgs(2)
winDivertDir = objArgs(3)
readyFile = objArgs(4)

argsStr = "--token " & token & " --port " & port & " --windivert-dir """ & winDivertDir & """ --ready-file """ & readyFile & """"

Set objShell = CreateObject("Shell.Application")
objShell.ShellExecute exePath, argsStr, winDivertDir, "runas", 1
