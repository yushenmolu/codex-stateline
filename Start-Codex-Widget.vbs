Option Explicit
Dim shell, fso, root, scriptPath, command, exitCode
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
scriptPath = fso.BuildPath(root, "scripts\start-floating-widget.ps1")
shell.CurrentDirectory = root
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File " & Chr(34) & scriptPath & Chr(34)
exitCode = shell.Run(command, 0, True)
If exitCode <> 0 Then
  MsgBox "Codex widget failed to start or stopped with an error. Run npm run desktop in the project folder to see details.", vbExclamation, "Codex Widget"
End If
WScript.Quit exitCode
